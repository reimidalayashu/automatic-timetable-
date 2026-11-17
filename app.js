// ============================================================
//  Timetable Generator — Complete Rewrite
//  Fixes:
//    1. sessionsPerWeek strictly enforced (no overflows)
//    2. No subject appears more than once per day (hard constraint)
//    3. Teacher conflict detection (no double-booking)
//    4. Holiday + 2nd/4th Saturday detection
//    5. Missed sessions redistributed to available days
//    6. Free slots shown as "Free" instead of random fill
// ============================================================

// ---------- India Fixed Holidays (MM-DD format) ----------
const INDIA_HOLIDAYS = new Set([
    "01-01","01-14","01-26","02-14","03-08","03-25","03-29",
    "04-09","04-14","04-17","04-21","05-23","06-17","07-17",
    "08-15","08-26","09-07","09-16","09-28","10-02","10-12",
    "10-31","11-15","11-30","12-25"
]);

// ---------- Utility Helpers ----------
function zeroPad(n){ return String(n).padStart(2,"0"); }

function formatMMDD(date){
    return zeroPad(date.getMonth()+1)+"-"+zeroPad(date.getDate());
}

function formatDDMM(date){
    return zeroPad(date.getDate())+"-"+zeroPad(date.getMonth()+1);
}

function isSecondSaturday(date){
    if(date.getDay() !== 6) return false;
    const dom = date.getDate();
    return dom >= 8 && dom <= 14;
}

function isFourthSaturday(date){
    if(date.getDay() !== 6) return false;
    const dom = date.getDate();
    return dom >= 22 && dom <= 28;
}

function isSecondOrFourthSaturday(date){
    return isSecondSaturday(date) || isFourthSaturday(date);
}

function getSaturdayLabel(date){
    if(isSecondSaturday(date))  return "2nd Saturday";
    if(isFourthSaturday(date))  return "4th Saturday";
    return "Saturday Holiday";
}

function isHolidayDate(date){
    if(isSecondOrFourthSaturday(date)) return true;
    return INDIA_HOLIDAYS.has(formatMMDD(date));
}

/** Fisher-Yates shuffle — returns a new shuffled array */
function shuffle(arr){
    const a = arr.slice();
    for(let i = a.length-1; i > 0; i--){
        const j = Math.floor(Math.random()*(i+1));
        [a[i],a[j]] = [a[j],a[i]];
    }
    return a;
}

// ============================================================
//  TimetableApp Class
// ============================================================
class TimetableApp {
    constructor(){
        this.subjects  = [];
        this.teachers  = [];
        this.classes   = [];
        this.timetable = null;

        // Time slots — break/lunch rows are marked automatically
        this.settings = {
            workingDays: ["monday","tuesday","wednesday","thursday","friday","saturday"],
            timeSlots: [
                "09:30-10:30",
                "10:30-10:40 (Break)",
                "10:40-11:40",
                "11:40-12:40",
                "12:40-01:20 (Lunch)",
                "01:20-02:15",
                "02:15-02:20 (Break)",
                "02:20-03:15",
                "03:15-04:10"
            ]
        };

        // Custom holidays added by the user: array of { dateISO: "YYYY-MM-DD", label: "..." }
        this.customHolidays = [];

        // Derived: slots that are actual teaching periods
        this.teachingSlots = this.settings.timeSlots.filter(s =>
            !s.toLowerCase().includes("break") && !s.toLowerCase().includes("lunch")
        );

        this.init();
    }

    // --------------------------------------------------------
    //  Initialization
    // --------------------------------------------------------
    init(){
        this.setupTabs();
        this.setupForms();
        this.setupExportPrint();
        this.setupColorPickers();
        this.setupRoomFilters();
        this.setupTheme();
        this.loadFromStorage();
        this.setupPalettes();         // ← color palette presets
        this.updateDashboard();
        this.renderCustomHolidays();
        this.logActivity("Application initialized");
    }

    // --------------------------------------------------------
    //  Tabs
    // --------------------------------------------------------
    setupTabs(){
        document.querySelectorAll(".nav-tab").forEach(btn => {
            btn.addEventListener("click", e => {
                document.querySelectorAll(".nav-tab").forEach(b => b.classList.remove("active"));
                document.querySelectorAll(".tab-content").forEach(t => t.classList.remove("active"));
                const tab = e.currentTarget.dataset.tab;
                e.currentTarget.classList.add("active");
                document.getElementById(tab)?.classList.add("active");
                if(tab === "subjects")  this.renderSubjects();
                if(tab === "teachers")  this.renderTeachers();
                if(tab === "classes") { this.renderClasses(); this.renderRoomStats(); }
                if(tab === "generate")  this.renderPaletteGrid();
            });
        });
    }

    // --------------------------------------------------------
    //  Dashboard
    // --------------------------------------------------------
    updateDashboard(){
        document.getElementById("subjects-count").textContent = this.subjects.length;
        document.getElementById("teachers-count").textContent = this.teachers.length;
        document.getElementById("classes-count").textContent  = this.classes.length;
    }

    logActivity(msg){
        const ul = document.getElementById("activity-log");
        if(!ul) return;
        const li = document.createElement("li");
        const now = new Date();
        li.textContent = `[${zeroPad(now.getHours())}:${zeroPad(now.getMinutes())}] ${msg}`;
        ul.prepend(li);
        // Keep log at most 20 entries
        while(ul.children.length > 20) ul.removeChild(ul.lastChild);
    }

    // --------------------------------------------------------
    //  Forms — wire up all submit handlers
    // --------------------------------------------------------
    setupForms(){
        document.getElementById("subject-form")?.addEventListener("submit", e => this.addSubject(e));
        document.getElementById("teacher-form")?.addEventListener("submit", e => this.addTeacher(e));
        document.getElementById("class-form")?.addEventListener("submit",   e => this.addClass(e));
        document.getElementById("generate-btn")?.addEventListener("click",  () => this.generateTimetable());
        document.getElementById("add-holiday-btn")?.addEventListener("click", () => this.addCustomHoliday());
    }

    // --------------------------------------------------------
    //  COLOR PICKER — bidirectional swatch ↔ hex text sync
    // --------------------------------------------------------
    setupColorPickers(){
        // Each pair: { swatchId, hexId, formName (the hidden color input name on the form) }
        const pairs = [
            { swatchId: "subject-color-swatch", hexId: "subject-color-hex" },
            { swatchId: "room-color-swatch",    hexId: "room-color-hex"    }
        ];

        pairs.forEach(({ swatchId, hexId }) => {
            const swatch = document.getElementById(swatchId);
            const hexInp = document.getElementById(hexId);
            if(!swatch || !hexInp) return;

            // Swatch changed → update hex text
            swatch.addEventListener("input", () => {
                hexInp.value = swatch.value.toUpperCase();
            });

            // Hex text changed → update swatch (validate first)
            const syncHexToSwatch = () => {
                let val = hexInp.value.trim();
                if(!val.startsWith("#")) val = "#" + val;
                if(/^#[0-9A-Fa-f]{6}$/.test(val)){
                    swatch.value      = val.toLowerCase();
                    hexInp.value      = val.toUpperCase();
                    hexInp.style.borderColor = "";
                } else {
                    hexInp.style.borderColor = "#d63031"; // red border for invalid
                }
            };

            hexInp.addEventListener("input",  syncHexToSwatch);
            hexInp.addEventListener("blur",   syncHexToSwatch);
            hexInp.addEventListener("keydown", e => {
                if(e.key === "Enter"){ e.preventDefault(); syncHexToSwatch(); }
            });
        });
    }

    // --------------------------------------------------------
    //  ROOM SEARCH / FILTER / STATS
    // --------------------------------------------------------
    setupRoomFilters(){
        const search  = document.getElementById("room-search");
        const typeF   = document.getElementById("room-type-filter");
        const statusF = document.getElementById("room-status-filter");
        const subjSearch = document.getElementById("subject-search");

        search?.addEventListener("input",  () => this.renderClasses());
        typeF?.addEventListener("change",  () => this.renderClasses());
        statusF?.addEventListener("change",() => this.renderClasses());
        subjSearch?.addEventListener("input", () => this.renderSubjects());
    }

    renderRoomStats(){
        const bar = document.getElementById("room-stats-bar");
        if(!bar) return;
        const total      = this.classes.length;
        const regular    = this.classes.filter(c => c.type === "Regular").length;
        const labs       = this.classes.filter(c => c.type === "Lab").length;
        const auditoriums= this.classes.filter(c => c.type === "Auditorium").length;
        const available  = this.classes.filter(c => (c.status||"Available") === "Available").length;
        const totalCap   = this.classes.reduce((s, c) => s + (c.capacity||0), 0);

        const chips = [
            { icon: "🏫", label: "Total Rooms",   val: total },
            { icon: "📚", label: "Classrooms",    val: regular },
            { icon: "🔬", label: "Labs",           val: labs },
            { icon: "🎭", label: "Auditoriums",   val: auditoriums },
            { icon: "✅", label: "Available",      val: available },
            { icon: "👥", label: "Total Capacity", val: totalCap },
        ];

        bar.innerHTML = chips.map(c =>
            `<div class="room-stat-chip">
                <span>${c.icon}</span>
                <span>${c.label}: <strong>${c.val}</strong></span>
             </div>`
        ).join("");
    }
    addCustomHoliday(){
        const dateInput  = document.getElementById("holiday-date-input");
        const labelInput = document.getElementById("holiday-label-input");
        const dateVal    = (dateInput?.value || "").trim();   // "YYYY-MM-DD"
        const labelVal   = (labelInput?.value || "").trim() || "Holiday";

        // Validate format YYYY-MM-DD
        if(!/^\d{4}-\d{2}-\d{2}$/.test(dateVal)){
            alert("Please enter a valid date in YYYY-MM-DD format."); return;
        }

        // Prevent duplicates
        if(this.customHolidays.some(h => h.dateISO === dateVal)){
            alert(`${dateVal} is already added as a holiday.`); return;
        }

        this.customHolidays.push({ dateISO: dateVal, label: labelVal });
        this.renderCustomHolidays();
        this.logActivity(`Custom holiday added: ${labelVal} (${dateVal})`);
        if(dateInput)  dateInput.value  = "";
        if(labelInput) labelInput.value = "";
    }

    removeCustomHoliday(dateISO){
        this.customHolidays = this.customHolidays.filter(h => h.dateISO !== dateISO);
        this.renderCustomHolidays();
        this.logActivity(`Custom holiday removed: ${dateISO}`);
    }

    renderCustomHolidays(){
        const container = document.getElementById("custom-holidays-list");
        if(!container) return;

        if(this.customHolidays.length === 0){
            container.innerHTML = `<p style="color:#484f58;font-size:0.82em;margin:0">
                No custom holidays added yet.</p>`;
            return;
        }

        // Sort chronologically for display
        const sorted = this.customHolidays.slice().sort((a, b) => a.dateISO.localeCompare(b.dateISO));

        container.innerHTML = `
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:4px">
            ${sorted.map(h => {
                // Format display: YYYY-MM-DD → DD-Mon-YYYY
                const d = new Date(h.dateISO + "T00:00:00");
                const display = isNaN(d)
                    ? h.dateISO
                    : d.toLocaleDateString("en-IN", { day:"2-digit", month:"short", year:"numeric" });
                return `
                <div style="display:flex;align-items:center;gap:8px;background:var(--color-surface);
                            border:1px solid var(--color-border);border-radius:6px;padding:6px 10px;font-size:0.83em">
                    <span style="color:#ff7675">📅</span>
                    <span style="color:var(--color-text);font-weight:600">${display}</span>
                    <span style="color:var(--color-text-secondary)">${h.label}</span>
                    <button onclick="app.removeCustomHoliday('${h.dateISO}')"
                            style="background:#d63031;color:#fff;border:none;border-radius:4px;
                                   padding:2px 7px;cursor:pointer;font-size:0.8em;margin-left:4px">✕</button>
                </div>`;
            }).join("")}
        </div>`;
    }

    /** Returns true if a Date object matches any custom holiday */
    isCustomHoliday(date){
        // Compare as YYYY-MM-DD
        const iso = `${date.getFullYear()}-${zeroPad(date.getMonth()+1)}-${zeroPad(date.getDate())}`;
        return this.customHolidays.some(h => h.dateISO === iso);
    }

    /** Get label for a custom holiday date (for display in timetable) */
    getCustomHolidayLabel(date){
        const iso = `${date.getFullYear()}-${zeroPad(date.getMonth()+1)}-${zeroPad(date.getDate())}`;
        return this.customHolidays.find(h => h.dateISO === iso)?.label || "Holiday";
    }
    addSubject(e){
        e.preventDefault();
        const f = e.target;
        // Read validated color from the swatch (always valid hex)
        const colorVal = document.getElementById("subject-color-swatch")?.value || "#4ECDC4";
        const subject = {
            name:           f.name.value.trim(),
            code:           f.code.value.trim().toUpperCase(),
            type:           f.type.value,
            duration:       parseInt(f.duration.value) || 1,
            sessionsPerWeek:parseInt(f.sessionsPerWeek.value) || 1,
            color:          colorVal
        };
        if(!subject.name || !subject.code){ alert("Subject name and code are required!"); return; }
        if(this.subjects.some(s => s.code === subject.code)){
            alert(`Subject code "${subject.code}" already exists!`); return;
        }
        this.subjects.push(subject);
        this.renderSubjects();
        this.updateDashboard();
        this.updateTeacherSubjectOptions();
        this.logActivity(`Subject added: ${subject.name} (${subject.code})`);
        f.reset();
        // Reset color pickers to default
        const sw = document.getElementById("subject-color-swatch");
        const hx = document.getElementById("subject-color-hex");
        if(sw) sw.value = "#4ECDC4";
        if(hx) hx.value = "#4ECDC4";
    }

    renderSubjects(){
        const tbody = document.querySelector("#subjects-table tbody");
        if(!tbody) return;
        const search = (document.getElementById("subject-search")?.value || "").toLowerCase();
        const list   = search
            ? this.subjects.filter(s =>
                s.name.toLowerCase().includes(search) ||
                s.code.toLowerCase().includes(search) ||
                s.type.toLowerCase().includes(search))
            : this.subjects;

        tbody.innerHTML = "";
        list.forEach((s) => {
            const i = this.subjects.indexOf(s);
            const tr = document.createElement("tr");
            tr.innerHTML = `
                <td>${s.name}</td>
                <td>${s.code}</td>
                <td>${s.type}</td>
                <td>${s.duration}h</td>
                <td>${s.sessionsPerWeek}</td>
                <td>
                    <span style="display:inline-block;width:24px;height:24px;border-radius:4px;
                                 background:${s.color};border:1px solid rgba(255,255,255,0.15);
                                 vertical-align:middle" title="${s.color}"></span>
                    <span style="font-size:0.78em;color:#adb5bd;margin-left:5px;
                                 font-family:monospace">${s.color.toUpperCase()}</span>
                </td>
                <td>
                    <button class="btn btn--sm btn--warning" onclick="app.editSubject(${i})">Edit</button>
                    <button class="btn btn--sm btn--danger"  onclick="app.deleteSubject(${i})">Delete</button>
                </td>`;
            tbody.appendChild(tr);
        });
    }

    deleteSubject(i){
        if(!confirm(`Delete subject "${this.subjects[i].name}"?`)) return;
        this.logActivity(`Subject deleted: ${this.subjects[i].name}`);
        this.subjects.splice(i, 1);
        this.renderSubjects();
        this.updateDashboard();
        this.updateTeacherSubjectOptions();
    }

    editSubject(i){
        const s = this.subjects[i];
        const f = document.getElementById("subject-form");
        if(!f) return;
        f.name.value            = s.name;
        f.code.value            = s.code;
        f.type.value            = s.type;
        f.duration.value        = s.duration;
        f.sessionsPerWeek.value = s.sessionsPerWeek;

        const sw = document.getElementById("subject-color-swatch");
        const hx = document.getElementById("subject-color-hex");
        if(sw) sw.value = s.color || "#4ECDC4";
        if(hx) hx.value = (s.color || "#4ECDC4").toUpperCase();

        f.scrollIntoView({ behavior: "smooth", block: "start" });

        const btn = f.querySelector("button[type='submit']");
        btn.textContent = "Update Subject";
        // Use onclick to prevent stacking handlers on repeated edits
        btn.onclick = ev => {
            ev.preventDefault();
            s.name            = f.name.value.trim();
            s.code            = f.code.value.trim().toUpperCase();
            s.type            = f.type.value;
            s.duration        = parseInt(f.duration.value) || 1;
            s.sessionsPerWeek = parseInt(f.sessionsPerWeek.value) || 1;
            s.color           = document.getElementById("subject-color-swatch")?.value || "#4ECDC4";
            btn.textContent   = "Add Subject";
            btn.onclick       = null;
            f.reset();
            if(sw){ sw.value = "#4ECDC4"; } if(hx){ hx.value = "#4ECDC4"; }
            this.renderSubjects();
            this.updateDashboard();
            this.updateTeacherSubjectOptions();
            this.logActivity(`Subject updated: ${s.name}`);
        };
    }

    // --------------------------------------------------------
    //  TEACHERS — CRUD
    // --------------------------------------------------------
    updateTeacherSubjectOptions(){
        const select = document.querySelector("#teacher-form select[name='subjects']");
        if(!select) return;
        const prev = Array.from(select.selectedOptions).map(o => o.value);
        select.innerHTML = "";
        this.subjects.forEach(s => {
            const opt = document.createElement("option");
            opt.value       = s.code;
            opt.textContent = `${s.name} (${s.code})`;
            if(prev.includes(s.code)) opt.selected = true;
            select.appendChild(opt);
        });
    }

    addTeacher(e){
        e.preventDefault();
        const data = new FormData(e.target);
        const selectedSubjects = Array.from(data.getAll("subjects"));
        if(selectedSubjects.length === 0){
            alert("Please select at least one subject for the teacher!"); return;
        }
        const teacher = {
            name:          data.get("name").trim(),
            id:            data.get("id").trim(),
            subjects:      selectedSubjects,
            maxHoursPerDay:parseInt(data.get("maxHoursPerDay")) || 6
        };
        if(!teacher.name || !teacher.id){ alert("Teacher name and ID are required!"); return; }
        this.teachers.push(teacher);
        this.renderTeachers();
        this.updateDashboard();
        this.logActivity(`Teacher added: ${teacher.name}`);
        e.target.reset();
    }

    renderTeachers(){
        const tbody = document.querySelector("#teachers-table tbody");
        if(!tbody) return;
        tbody.innerHTML = "";
        this.teachers.forEach((t, i) => {
            // Resolve codes to names for display
            const subNames = t.subjects.map(code => {
                const s = this.subjects.find(x => x.code === code);
                return s ? s.name : code;
            }).join(", ");
            const tr = document.createElement("tr");
            tr.innerHTML = `
                <td>${t.name}</td>
                <td>${t.id}</td>
                <td>${subNames}</td>
                <td>${t.maxHoursPerDay}</td>
                <td>
                    <button class="btn btn--sm btn--warning" onclick="app.editTeacher(${i})">Edit</button>
                    <button class="btn btn--sm btn--danger"  onclick="app.deleteTeacher(${i})">Delete</button>
                </td>`;
            tbody.appendChild(tr);
        });
    }

    deleteTeacher(i){
        if(!confirm(`Delete teacher "${this.teachers[i].name}"?`)) return;
        this.logActivity(`Teacher deleted: ${this.teachers[i].name}`);
        this.teachers.splice(i, 1);
        this.renderTeachers();
        this.updateDashboard();
    }

    editTeacher(i){
        const t = this.teachers[i];
        const f = document.getElementById("teacher-form");
        if(!f) return;
        f.name.value          = t.name;
        f.id.value            = t.id;
        f.maxHoursPerDay.value= t.maxHoursPerDay;
        this.updateTeacherSubjectOptions();
        const select = f.querySelector("select[name='subjects']");
        Array.from(select.options).forEach(opt => {
            opt.selected = t.subjects.includes(opt.value);
        });
        f.scrollIntoView({ behavior: "smooth", block: "start" });
        const btn = f.querySelector("button[type='submit']");
        btn.textContent = "Update Teacher";
        btn.onclick = ev => {
            ev.preventDefault();
            t.name           = f.name.value.trim();
            t.id             = f.id.value.trim();
            t.maxHoursPerDay = parseInt(f.maxHoursPerDay.value) || 6;
            t.subjects       = Array.from(select.selectedOptions).map(o => o.value);
            if(t.subjects.length === 0){
                alert("Please select at least one subject!"); return;
            }
            btn.textContent = "Add Teacher";
            btn.onclick     = null;
            f.reset();
            this.renderTeachers();
            this.updateDashboard();
            this.logActivity(`Teacher updated: ${t.name}`);
        };
    }

    // --------------------------------------------------------
    //  CLASSES/ROOMS — CRUD
    // --------------------------------------------------------
    addClass(e){
        e.preventDefault();
        const data = new FormData(e.target);
        // Read color from the swatch input (which is always valid hex)
        const colorVal = document.getElementById("room-color-swatch")?.value || "#2D9CDB";
        const c = {
            name:     data.get("name").trim(),
            capacity: parseInt(data.get("capacity")) || 0,
            type:     data.get("type"),
            color:    colorVal,
            floor:    (data.get("floor") || "").trim(),
            status:   data.get("status") || "Available"
        };
        if(!c.name){ alert("Room name is required!"); return; }
        this.classes.push(c);
        this.renderClasses();
        this.renderRoomStats();
        this.updateDashboard();
        this.logActivity(`Room added: ${c.name}`);
        e.target.reset();
        // Reset color pickers to default
        const sw = document.getElementById("room-color-swatch");
        const hx = document.getElementById("room-color-hex");
        if(sw) sw.value = "#2D9CDB";
        if(hx) hx.value = "#2D9CDB";
    }

    renderClasses(){
        const tbody    = document.querySelector("#classes-table tbody");
        if(!tbody) return;

        const search   = (document.getElementById("room-search")?.value   || "").toLowerCase();
        const typeF    = (document.getElementById("room-type-filter")?.value || "");
        const statusF  = (document.getElementById("room-status-filter")?.value || "");

        const filtered = this.classes.filter((c, _) => {
            if(search  && !c.name.toLowerCase().includes(search) &&
                         !((c.floor||"").toLowerCase().includes(search))) return false;
            if(typeF   && c.type   !== typeF)   return false;
            if(statusF && (c.status||"Available") !== statusF) return false;
            return true;
        });

        tbody.innerHTML = "";

        const emptyMsg = document.getElementById("room-empty-msg");
        if(filtered.length === 0 && this.classes.length > 0){
            if(emptyMsg) emptyMsg.style.display = "block";
        } else {
            if(emptyMsg) emptyMsg.style.display = "none";
        }

        filtered.forEach((c) => {
            const realIdx = this.classes.indexOf(c);
            const statusClass = {
                "Available":        "status-available",
                "Under Maintenance":"status-maintenance",
                "Reserved":         "status-reserved"
            }[c.status || "Available"] || "status-available";

            const tr = document.createElement("tr");
            tr.innerHTML = `
                <td>
                    <span style="display:inline-block;width:28px;height:28px;border-radius:6px;
                                 background:${c.color||"#2D9CDB"};border:1px solid rgba(255,255,255,0.15);
                                 vertical-align:middle" title="${c.color||""}"></span>
                </td>
                <td style="font-weight:600">${c.name}</td>
                <td>${c.capacity}</td>
                <td>${c.type}</td>
                <td style="color:#adb5bd;font-size:0.88em">${c.floor || "—"}</td>
                <td><span class="status-badge ${statusClass}">${c.status || "Available"}</span></td>
                <td>
                    <button class="btn btn--sm btn--warning" onclick="app.editClass(${realIdx})">Edit</button>
                    <button class="btn btn--sm btn--danger"  onclick="app.deleteClass(${realIdx})">Delete</button>
                </td>`;
            tbody.appendChild(tr);
        });
    }

    deleteClass(i){
        if(!confirm(`Delete room "${this.classes[i].name}"?`)) return;
        this.logActivity(`Room deleted: ${this.classes[i].name}`);
        this.classes.splice(i, 1);
        this.renderClasses();
        this.renderRoomStats();
        this.updateDashboard();
    }

    editClass(i){
        const c = this.classes[i];
        const f = document.getElementById("class-form");
        if(!f) return;
        f.name.value     = c.name;
        f.capacity.value = c.capacity;
        f.type.value     = c.type;
        f.floor.value    = c.floor || "";
        f.status.value   = c.status || "Available";

        const sw = document.getElementById("room-color-swatch");
        const hx = document.getElementById("room-color-hex");
        const col = c.color || "#2D9CDB";
        if(sw) sw.value = col;
        if(hx) hx.value = col.toUpperCase();

        f.scrollIntoView({ behavior: "smooth", block: "start" });
        const btn = f.querySelector("button[type='submit']");
        btn.textContent = "Update Room";
        btn.onclick = ev => {
            ev.preventDefault();
            c.name     = f.name.value.trim();
            c.capacity = parseInt(f.capacity.value) || 0;
            c.type     = f.type.value;
            c.color    = document.getElementById("room-color-swatch")?.value || c.color;
            c.floor    = (f.floor?.value || "").trim();
            c.status   = f.status?.value || "Available";
            btn.textContent = "Add Room";
            btn.onclick = null;
            f.reset();
            if(sw){ sw.value = "#2D9CDB"; } if(hx){ hx.value = "#2D9CDB"; }
            this.renderClasses();
            this.renderRoomStats();
            this.updateDashboard();
            this.logActivity(`Room updated: ${c.name}`);
        };
    }

    // --------------------------------------------------------
    //  TIMETABLE GENERATION ENGINE
    // --------------------------------------------------------

    /**
     * Returns the Date object for each working day of the current week.
     * Monday = index 0 (JS getDay: Mon=1, Tue=2 ... Sun=0).
     */
    getWeekDates(){
        const today = new Date();
        // Shift week to start on Monday
        const dayOfWeek = today.getDay() === 0 ? 7 : today.getDay(); // Sun=7
        const monday = new Date(today);
        monday.setDate(today.getDate() - dayOfWeek + 1);
        monday.setHours(0,0,0,0);

        const map = {};
        const dayNames = ["monday","tuesday","wednesday","thursday","friday","saturday"];
        dayNames.forEach((name, idx) => {
            const d = new Date(monday);
            d.setDate(monday.getDate() + idx);
            map[name] = d;
        });
        return map;
    }

    /**
     * Find the best teacher for a given subject code.
     * Returns the teacher with fewest total sessions scheduled so far (load balancing).
     */
    getTeacherForSubject(subCode, teacherLoad){
        const eligible = this.teachers.filter(t =>
            Array.isArray(t.subjects) && t.subjects.includes(subCode)
        );
        if(eligible.length === 0) return this.teachers[0] || null;
        // Pick least-loaded eligible teacher
        eligible.sort((a, b) => (teacherLoad[a.name] || 0) - (teacherLoad[b.name] || 0));
        return eligible[0];
    }

    /**
     * Find a suitable room for a subject.
     * Lab subjects prefer Lab rooms; Theory subjects prefer Regular rooms.
     * Falls back to any available room.
     */
    getClassForSubject(subject){
        if(!this.classes.length) return null;
        const preferred = this.classes.filter(c => {
            if(subject.type === "Lab" || subject.type === "Practical")
                return c.type === "Lab";
            return c.type === "Regular";
        });
        if(preferred.length) return preferred[Math.floor(Math.random()*preferred.length)];
        return this.classes[Math.floor(Math.random()*this.classes.length)];
    }

    /**
     * Teaching slot indices that are truly adjacent (no break/lunch between them
     * in the full time-slot array). Blocks that start at these indices avoid
     * visual gaps when displayed.
     *
     * Full slot layout:
     *   idx 0: 09:30-10:30   → teaching[0]
     *   idx 1: Break
     *   idx 2: 10:40-11:40   → teaching[1]
     *   idx 3: 11:40-12:40   → teaching[2]
     *   idx 4: Lunch
     *   idx 5: 01:20-02:15   → teaching[3]
     *   idx 6: Break
     *   idx 7: 02:20-03:15   → teaching[4]
     *   idx 8: 03:15-04:10   → teaching[5]
     *
     * Adjacent pairs of teaching slots (no separator between them):
     *   teaching[1] + teaching[2]  →  startIdx = 1, size 2
     *   teaching[4] + teaching[5]  →  startIdx = 4, size 2
     * Adjacent triple: none exist in the current schedule template.
     */
    isAdjacentBlock(startIdx, size){
        if(size === 1) return true;
        if(size === 2) return startIdx === 1 || startIdx === 4;
        return false; // 3h+ blocks will span across breaks; still allowed but deprioritised
    }

    /**
     * Core generation algorithm — constraint-based greedy scheduler.
     *
     * Hard constraints:
     *   1. A subject appears at most MAX_PER_DAY times per day (normally 1).
     *   2. sessionsPerWeek is the exact target for each subject.
     *   3. A teacher cannot be double-booked on the same slot.
     *   4. A teacher's maxHoursPerDay is respected.
     *   5. Holiday days have no teaching sessions.
     *
     * Soft constraint / redistribution:
     *   - If a day is a holiday, its "missed" sessions are redistributed to other
     *     available days (max +1 extra per subject per day as a fallback).
     */
    generateTimetable(){
        if(!this.subjects.length || !this.teachers.length || !this.classes.length){
            alert("Please add Subjects, Teachers, and Classes/Rooms before generating!"); return;
        }

        // -- Step 1: Determine dates and holidays for this week --
        const weekDates  = this.getWeekDates();
        const { workingDays, timeSlots } = this.settings;

        const holidayInfo = {}; // day -> { isHoliday, dateStr, label }
        workingDays.forEach(day => {
            const d = weekDates[day];
            const fixedHol   = isHolidayDate(d);
            const customHol  = this.isCustomHoliday(d);
            const isHoliday  = fixedHol || customHol;
            let label        = "";
            if(isSecondOrFourthSaturday(d))   label = getSaturdayLabel(d);
            else if(fixedHol)                  label = "Public Holiday";
            else if(customHol)                 label = this.getCustomHolidayLabel(d);
            holidayInfo[day] = { isHoliday, dateStr: formatDDMM(d), label };
        });

        const activeDays = workingDays.filter(day => !holidayInfo[day].isHoliday);

        if(activeDays.length === 0){
            alert("All days this week are holidays!"); return;
        }

        // -- Step 2: Slot counts --
        const slotsPerDay = this.teachingSlots.length; // 6 teaching slots per day

        // -- Step 3: Build session requirements --
        // maxPerDay (pass 1): spread evenly — at most ceil(N/activeDays) per day.
        //   e.g. 3 sessions over 5 days → max 1 per day.
        // maxPerDayRelaxed (pass 2 fallback): allow up to floor(slots/duration) per day
        //   so that a holiday doesn't leave sessions permanently unplaced.
        const sessionRequirements = this.subjects.map(sub => {
            const dur = Math.max(1, sub.duration);
            return {
                subject:         sub,
                maxPerDay:       Math.max(1, Math.ceil(sub.sessionsPerWeek / activeDays.length)),
                maxPerDayRelaxed:Math.max(1, Math.floor(slotsPerDay / dur)) // physical max per day
            };
        });

        // Non-blocking capacity notice (no confirm — just log it)
        const totalSlotDemand     = this.subjects.reduce((sum, s) => sum + s.sessionsPerWeek * s.duration, 0);
        const totalSlotsAvailable = activeDays.length * slotsPerDay;
        if(totalSlotDemand > totalSlotsAvailable){
            this.logActivity(
                `ℹ️ Capacity: need ${totalSlotDemand} slot-hours, have ${totalSlotsAvailable} `+
                `(${activeDays.length} days × ${slotsPerDay} slots). Some sessions redistributed to fit.`
            );
        }

        // -- Step 4: Build scheduling grid --
        // grid[day][slotIndex] = entry | null
        const grid = {};
        activeDays.forEach(day => { grid[day] = new Array(slotsPerDay).fill(null); });

        // Tracking structures
        const subjectDayCount = {}; // subCode -> { day -> sessions placed }
        const teacherDayHours = {}; // teacherName -> { day -> hours consumed }
        const teacherSlotBusy = {}; // teacherName -> Set<"day|slotIdx">
        const teacherLoad     = {}; // teacherName -> total sessions (load balancing)

        this.subjects.forEach(s => {
            subjectDayCount[s.code] = {};
            activeDays.forEach(d => { subjectDayCount[s.code][d] = 0; });
        });
        this.teachers.forEach(t => {
            teacherDayHours[t.name] = {};
            teacherSlotBusy[t.name] = new Set();
            teacherLoad[t.name]     = 0;
            activeDays.forEach(d => { teacherDayHours[t.name][d] = 0; });
        });

        // -- Step 5: Sort subjects: longest duration first, then most sessions first --
        // Hardest-to-place subjects get first pick of slots.
        const orderedReqs = sessionRequirements.slice().sort((a, b) => {
            const durDiff = b.subject.duration - a.subject.duration;
            if(durDiff !== 0) return durDiff;
            return b.subject.sessionsPerWeek - a.subject.sessionsPerWeek;
        });

        // -- Step 6: Core placement helper --
        // Tries to place one session of `sub` across `duration` consecutive free slots.
        // `maxPD` = max times this subject may appear on any single day this pass.
        // Returns true if placed successfully.
        const placeOneSession = (sub, req, maxPD) => {
            const duration = Math.max(1, sub.duration);

            // Prefer days where this subject has appeared least (even distribution)
            const candidateDays = shuffle(activeDays).sort(
                (a, b) => (subjectDayCount[sub.code][a]||0) - (subjectDayCount[sub.code][b]||0)
            );

            for(const day of candidateDays){
                // Per-day subject cap
                if((subjectDayCount[sub.code][day]||0) >= maxPD) continue;

                const teacher = this.getTeacherForSubject(sub.code, teacherLoad);

                // Teacher max-hours-per-day guard
                if(teacher){
                    const used = teacherDayHours[teacher.name][day] || 0;
                    if(used + duration > teacher.maxHoursPerDay) continue;
                }

                // Find a free consecutive block of `duration` slots
                const maxStart       = slotsPerDay - duration;
                if(maxStart < 0) continue;

                const startCandidates = shuffle([...Array(maxStart + 1).keys()]);
                // Prefer truly-adjacent slot groups (no hidden break/lunch between them)
                startCandidates.sort(a => this.isAdjacentBlock(a, duration) ? -1 : 1);

                let chosenStart = -1;
                for(const startIdx of startCandidates){
                    let free = true;
                    for(let k = 0; k < duration; k++){
                        const si = startIdx + k;
                        if(si >= slotsPerDay || grid[day][si] !== null){ free = false; break; }
                        if(teacher && teacherSlotBusy[teacher.name].has(`${day}|${si}`)){ free = false; break; }
                    }
                    if(free){ chosenStart = startIdx; break; }
                }

                if(chosenStart === -1) continue; // no free block on this day, try next day

                // ---- Place the session ----
                const classObj  = this.getClassForSubject(sub);
                const className = classObj ? classObj.name : "";

                for(let k = 0; k < duration; k++){
                    const si = chosenStart + k;
                    grid[day][si] = {
                        subject:        sub,
                        teacher:        teacher,
                        className:      className,
                        isStart:        k === 0,
                        isContinuation: k > 0,
                        spanSize:       duration
                    };
                    if(teacher) teacherSlotBusy[teacher.name].add(`${day}|${si}`);
                }

                // Update counters (once per session)
                subjectDayCount[sub.code][day] = (subjectDayCount[sub.code][day]||0) + 1;
                if(teacher){
                    teacherDayHours[teacher.name][day] = (teacherDayHours[teacher.name][day]||0) + duration;
                    teacherLoad[teacher.name]           = (teacherLoad[teacher.name]||0) + 1;
                }
                return true;
            }
            return false; // could not place on any day
        };

        // -- Step 7: Pass 1 — strict even distribution (maxPerDay) --
        const failedPass1 = []; // { req, sub } pairs that didn't fit in pass 1

        for(const req of orderedReqs){
            for(let attempt = 0; attempt < req.subject.sessionsPerWeek; attempt++){
                const ok = placeOneSession(req.subject, req, req.maxPerDay);
                if(!ok) failedPass1.push({ req, attempt });
            }
        }

        // -- Step 8: Pass 2 — relaxed redistribution for holiday-displaced sessions --
        // Allow up to maxPerDayRelaxed appearances on a single day.
        // This is what happens when a holiday cuts available days and strict limits
        // can no longer absorb all sessions.
        const finalUnplaced = [];

        for(const { req } of failedPass1){
            const ok = placeOneSession(req.subject, req, req.maxPerDayRelaxed);
            if(!ok) finalUnplaced.push(req.subject.name);
        }

        // -- Step 9b: Post-process — ensure no day starts with a free slot or activity subject --
        // "Activity" subjects are those whose name contains: sport, game, library,
        // assignment, activity, p.e., pe, ncc, nscc  (case-insensitive).
        const ACTIVITY_PATTERN = /sport|game|library|assignment|activity|\bp\.?e\.?\b|^ncc$|^nss$|^ncc\/nss$/i;

        activeDays.forEach(day => {
            const g = grid[day];
            if(!g || g.length === 0) return;

            // Pass A: if slot 0 is empty (null), swap with the first non-null slot
            if(g[0] === null){
                const swapIdx = g.findIndex((s, i) => i > 0 && s !== null && s.isStart);
                if(swapIdx !== -1){
                    // Swap the entire block (handle multi-slot sessions carefully)
                    // Simple case: both are single-slot sessions → straight swap
                    if(g[0] === null && g[swapIdx]?.spanSize === 1){
                        [g[0], g[swapIdx]] = [g[swapIdx], g[0]];
                    }
                }
            }

            // Pass B: if slot 0 has an activity/special subject, swap it to a later slot
            if(g[0] !== null && g[0].isStart && g[0].subject &&
               ACTIVITY_PATTERN.test(g[0].subject.name) && g[0].spanSize === 1){
                // Find first later slot that is either free or also a single-slot non-activity subject
                const swapIdx = g.findIndex((s, i) =>
                    i > 0 && (s === null || (s?.isStart && s?.spanSize === 1 &&
                    !ACTIVITY_PATTERN.test(s?.subject?.name || "")))
                );
                if(swapIdx !== -1){
                    [g[0], g[swapIdx]] = [g[swapIdx], g[0]];
                }
            }
        });
        if(finalUnplaced.length > 0){
            const tally = {};
            finalUnplaced.forEach(n => tally[n] = (tally[n]||0) + 1);
            const lines = Object.entries(tally).map(([n,c]) => `${n}(${c})`).join(", ");
            this.logActivity(`⚠️ Could not fit: ${lines} — reduce sessions/week or duration`);
        }

        // -- Step 10: Convert grid back to full timetable structure --
        const timetable = {};
        workingDays.forEach(day => {
            timetable[day] = [];
            let gridSlotIdx = 0;

            timeSlots.forEach(slotLabel => {
                const isBreak = slotLabel.toLowerCase().includes("break");
                const isLunch = slotLabel.toLowerCase().includes("lunch");

                if(isBreak || isLunch){
                    timetable[day].push({ isBreak: true, label: slotLabel });
                } else if(holidayInfo[day].isHoliday){
                    timetable[day].push({ isHoliday: true });
                } else {
                    const session = grid[day]?.[gridSlotIdx] || null;
                    if(session){
                        timetable[day].push({
                            subject:        session.subject,
                            teacher:        session.teacher,
                            className:      session.className,
                            isStart:        session.isStart,
                            isContinuation: session.isContinuation,
                            spanSize:       session.spanSize
                        });
                    } else {
                        timetable[day].push({ isFree: true });
                    }
                    gridSlotIdx++;
                }
            });
        });

        this.timetable = timetable;
        this.weekDates = weekDates;
        this.holidayInfo = holidayInfo;

        this.displayTimetable(timetable);
        this.logActivity("Timetable generated successfully");

        // Switch to the generate tab to show result
        document.getElementById("timetable-results")?.classList.remove("hidden");
    }

    // --------------------------------------------------------
    //  DISPLAY
    // --------------------------------------------------------
    displayTimetable(timetable){
        const container = document.getElementById("timetable-display");
        if(!container) return;

        const { workingDays, timeSlots } = this.settings;
        const weekDates  = this.weekDates  || this.getWeekDates();
        const holidayInf = this.holidayInfo || {};

        // ---- Session summary: count only START slots (not continuation) ----
        const sessionCount = {};
        this.subjects.forEach(s => sessionCount[s.code] = 0);
        workingDays.forEach(day => {
            (timetable[day] || []).forEach(slot => {
                if(slot.subject && !slot.isContinuation){
                    sessionCount[slot.subject.code] = (sessionCount[slot.subject.code]||0) + 1;
                }
            });
        });

        // ---- Capacity notice (non-blocking, shown inline) ----
        const totalDemand = this.subjects.reduce((sum, s) => sum + s.sessionsPerWeek * s.duration, 0);
        const totalCap    = Object.keys(timetable).filter(d => {
            const info = holidayInf[d] || {};
            return !info.isHoliday;
        }).length * this.teachingSlots.length;

        let capacityHtml = "";
        if(totalDemand > totalCap){
            const holidayDays = workingDays.filter(d => (holidayInf[d]||{}).isHoliday);
            const holidayNote = holidayDays.length > 0
                ? ` (${holidayDays.length} holiday day${holidayDays.length>1?"s":""} this week — sessions redistributed across remaining days)`
                : "";
            capacityHtml = `<div style="margin-bottom:14px;padding:10px 14px;
                background:var(--color-secondary);border:1px solid var(--color-primary);
                border-radius:8px;color:var(--color-text-secondary);font-size:0.82em">
                ℹ️ Total session demand (${totalDemand} slot-hours) exceeds available slots (${totalCap})${holidayNote}.
                Sessions are redistributed — subjects with higher demand may appear twice on some days.
            </div>`;
        }

        // ---- Header row ----
        let html = capacityHtml + `
        <h3 style="margin-bottom:16px;color:var(--color-text)">Master Timetable</h3>
        <div style="overflow-x:auto">
        <table class="timetable-table" style="border-collapse:collapse;min-width:900px;width:100%">
        <thead>
            <tr>
                <th class="tt-header tt-day-header">Day / Time</th>
                ${timeSlots.map(s => `<th class="tt-header">${s.replace("(Break)","<br><small>(Break)</small>").replace("(Lunch)","<br><small>(Lunch)</small>")}</th>`).join("")}
            </tr>
        </thead>
        <tbody>`;

        // ---- Day rows ----
        workingDays.forEach((day) => {
            const dayDate  = weekDates[day];
            const dateStr  = formatDDMM(dayDate);
            const info     = holidayInf[day] || {};
            const isHol    = info.isHoliday || false;
            const dayLabel = day.charAt(0).toUpperCase() + day.slice(1);

            html += `<tr>`;
            html += `<td class="tt-day-cell" style="${isHol ? "color:var(--tt-holiday-color,#e05555)" : ""}">
                        <span style="font-weight:700">${dayLabel}</span><br>
                        <span style="font-size:0.78em;opacity:0.75">${dateStr}</span>
                        ${isHol ? `<br><span style="font-size:0.70em;font-weight:700;letter-spacing:0.5px">HOLIDAY</span>` : ""}
                     </td>`;

            if(isHol){
                const holidayLabel = info.label || "Public Holiday";
                html += `<td colspan="${timeSlots.length}" class="tt-holiday-cell">
                            🎉 ${holidayLabel.toUpperCase()}
                         </td>`;
            } else {
                (timetable[day] || []).forEach(slot => {
                    if(slot.isBreak){
                        const lbl = slot.label.toLowerCase().includes("lunch") ? "LUNCH" : "BREAK";
                        html += `<td class="tt-break-cell">${lbl}</td>`;

                    } else if(slot.isContinuation){
                        // Same subject, subsequent hour — dimmer with dashed border
                        const bg      = slot.subject?.color || "#4ECDC4";
                        const textCol = this.contrastColor(bg);
                        html += `<td class="tt-session-cell"
                                    style="background:${bg};color:${textCol};opacity:0.7;
                                           border-left:2px dashed rgba(255,255,255,0.35)">
                                    <div style="font-size:0.75em;font-weight:600">▲ ${slot.subject.name}</div>
                                    <div style="font-size:0.68em;opacity:0.85">(${slot.subject.duration}h session)</div>
                                 </td>`;

                    } else if(slot.subject){
                        const bg      = slot.subject.color || "#4ECDC4";
                        const textCol = this.contrastColor(bg);
                        const durBadge = slot.subject.duration > 1
                            ? `<span style="background:rgba(0,0,0,0.28);border-radius:3px;
                                            padding:1px 5px;font-size:0.67em;margin-top:2px;
                                            display:inline-block">${slot.subject.duration}h</span>`
                            : "";
                        html += `<td class="tt-session-cell" style="background:${bg};color:${textCol}">
                                    <div style="font-weight:700;font-size:0.88em">${slot.subject.name}</div>
                                    ${durBadge}
                                    <div style="font-size:0.75em;opacity:0.9;margin-top:2px">${slot.teacher ? slot.teacher.name : "—"}</div>
                                    <div style="font-size:0.72em;opacity:0.8">${slot.className || ""}</div>
                                 </td>`;

                    } else if(slot.isFree){
                        html += `<td class="tt-free-cell">Free</td>`;
                    } else {
                        html += `<td class="tt-free-cell">—</td>`;
                    }
                });
            }
            html += `</tr>`;
        });

        html += `</tbody></table></div>`;

        // ---- Duration legend (only shown when multi-hour subjects exist) ----
        if(this.subjects.some(s => s.duration > 1)){
            html += `<div style="margin-top:10px;font-size:0.78em;color:var(--color-text-secondary);padding:7px 12px;
                                  background:var(--color-secondary);border-radius:6px;border-left:3px solid var(--color-primary)">
                ℹ️  Multi-hour subjects span consecutive time slots.
                The <strong style="color:var(--color-text)">first cell</strong> shows full details and a duration badge.
                <strong style="color:var(--color-text)">Continuation cells</strong> show ▲ with a dashed left border.
            </div>`;
        }

        // ---- Session summary ----
        html += `<div style="margin-top:20px;padding:14px;background:var(--color-surface);border-radius:8px;border:1px solid var(--color-border)">
            <h4 style="color:var(--color-primary);margin-bottom:10px">Session Summary (This Week)</h4>
            <div style="display:flex;flex-wrap:wrap;gap:10px">`;
        this.subjects.forEach(s => {
            const actual  = sessionCount[s.code] || 0;
            const target  = s.sessionsPerWeek;
            const ok      = actual === target;
            const partial = actual > 0 && actual < target;
            const color   = ok ? "#00b894" : (partial ? "#fdcb6e" : "#d63031");
            const durNote = s.duration > 1 ? ` · ${s.duration}h/session` : "";
            html += `<div style="background:var(--color-secondary);border:1px solid ${color};border-radius:6px;padding:6px 12px;min-width:150px">
                        <div style="display:flex;align-items:center;gap:6px">
                            <span style="width:10px;height:10px;border-radius:50%;background:${s.color};
                                          display:inline-block;flex-shrink:0"></span>
                            <span style="color:var(--color-text);font-size:0.85em;font-weight:600">${s.name}</span>
                        </div>
                        <div style="color:${color};font-size:0.78em;margin-top:3px">
                            ${actual}/${target} sessions${durNote} ${ok ? "✓" : (partial ? "(partial)" : "(none scheduled)")}
                        </div>
                     </div>`;
        });
        html += `</div></div>`;

        container.innerHTML = html;
        document.getElementById("timetable-results")?.classList.remove("hidden");
    }

    /**
     * Returns white or dark text color depending on background brightness.
     */
    contrastColor(hex){
        hex = hex.replace("#","");
        if(hex.length === 3) hex = hex.split("").map(c=>c+c).join("");
        const r = parseInt(hex.substring(0,2),16);
        const g = parseInt(hex.substring(2,4),16);
        const b = parseInt(hex.substring(4,6),16);
        const luminance = (0.299*r + 0.587*g + 0.114*b) / 255;
        return luminance > 0.55 ? "#1a1a2e" : "#ffffff";
    }

    // --------------------------------------------------------
    //  FILTER (view by teacher / class / subject)
    // --------------------------------------------------------
    setupFilters(){
        document.querySelectorAll(".view-btn").forEach(btn => {
            btn.addEventListener("click", e => {
                document.querySelectorAll(".view-btn").forEach(b => b.classList.remove("active"));
                e.currentTarget.classList.add("active");
                this.showFilterOptions(e.currentTarget.dataset.view);
            });
        });
    }

    showFilterOptions(view){
        const filterDiv = document.getElementById("filter-dropdown");
        if(!filterDiv) return;
        filterDiv.innerHTML = "";
        filterDiv.classList.add("hidden");
        if(view === "master"){ if(this.timetable) this.displayTimetable(this.timetable); return; }
        let list = [];
        if(view === "teacher") list = this.teachers.map(t => t.name);
        if(view === "class")   list = this.classes.map(c => c.name);
        if(view === "subject") list = this.subjects.map(s => s.name);
        const select = document.createElement("select");
        select.classList.add("form-control");
        const def = document.createElement("option");
        def.value = ""; def.textContent = `Select ${view}`;
        select.appendChild(def);
        list.forEach(v => { const o = document.createElement("option"); o.value = v; o.textContent = v; select.appendChild(o); });
        filterDiv.appendChild(select);
        filterDiv.classList.remove("hidden");
        select.addEventListener("change", () => {
            if(!select.value){ if(this.timetable) this.displayTimetable(this.timetable); return; }
            this.filterTimetable(view, select.value);
        });
    }

    filterTimetable(view, value){
        if(!this.timetable) return;
        const filtered = JSON.parse(JSON.stringify(this.timetable));
        Object.keys(filtered).forEach(day => {
            filtered[day] = filtered[day].map(slot => {
                if(slot.isBreak || slot.isHoliday || slot.isFree) return slot;
                if(view === "teacher" && slot.teacher?.name !== value) return { isFree: true };
                if(view === "subject" && slot.subject?.name !== value) return { isFree: true };
                if(view === "class"   && slot.className     !== value) return { isFree: true };
                return slot;
            });
        });
        this.displayTimetable(filtered);
    }

    // --------------------------------------------------------
    //  PRINT / EXPORT  (CSV + PDF + Print)
    // --------------------------------------------------------
    setupExportPrint(){
        document.getElementById("print-btn")?.addEventListener("click", () => window.print());
        document.getElementById("export-btn")?.addEventListener("click", () => this.exportCSV());
        document.getElementById("pdf-btn")?.addEventListener("click",   () => this.exportPDF());

        // Save-now and Clear-all buttons on the Dashboard
        document.getElementById("save-now-btn")?.addEventListener("click", () => {
            this.saveToStorage(true);
        });
        document.getElementById("clear-data-btn")?.addEventListener("click", () => {
            if(!confirm("This will erase ALL saved subjects, teachers and rooms.\nAre you sure?")) return;
            localStorage.removeItem("tt_subjects");
            localStorage.removeItem("tt_teachers");
            localStorage.removeItem("tt_classes");
            localStorage.removeItem("tt_holidays");
            this.subjects  = [];
            this.teachers  = [];
            this.classes   = [];
            this.customHolidays = [];
            this.renderSubjects();
            this.renderTeachers();
            this.renderClasses();
            this.renderRoomStats();
            this.renderCustomHolidays();
            this.updateDashboard();
            this.updateTeacherSubjectOptions();
            this._setSavedIndicator("All data cleared.", "");
            this.logActivity("All saved data cleared");
        });
    }

    exportCSV(){
        if(!this.timetable){ alert("Generate a timetable first!"); return; }
        const { workingDays, timeSlots } = this.settings;
        const weekDates = this.weekDates || this.getWeekDates();

        const rows = [["Day/Date", ...timeSlots]];
        workingDays.forEach(day => {
            const d = weekDates[day];
            const dateStr = formatDDMM(d);
            const dayLabel = day.charAt(0).toUpperCase() + day.slice(1) + " " + dateStr;
            const cells = (this.timetable[day] || []).map(slot => {
                if(slot.isHoliday) return "HOLIDAY";
                if(slot.isBreak)   return slot.label.includes("Lunch") ? "LUNCH" : "BREAK";
                if(slot.isFree)    return "Free";
                return `${slot.subject?.name || ""} | ${slot.teacher?.name || ""} | ${slot.className || ""}`;
            });
            rows.push([dayLabel, ...cells]);
        });

        const csv = rows.map(r => r.map(c => `"${(c||"").replace(/"/g,'""')}"`).join(",")).join("\r\n");
        const blob = new Blob([csv], { type:"text/csv" });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement("a");
        a.href     = url;
        a.download = `timetable_${formatDDMM(new Date())}.csv`;
        a.click();
        URL.revokeObjectURL(url);
        this.logActivity("Timetable exported as CSV");
    }

    // ============================================================
    //  FEATURE 4 — PDF EXPORT
    //  Uses jsPDF + html2canvas to snapshot the timetable and
    //  embed it as a landscape A4 PDF with a title header.
    // ============================================================
    async exportPDF(){
        if(!this.timetable){ alert("Generate a timetable first!"); return; }

        const overlay = document.getElementById("pdf-overlay");
        const msg     = overlay?.querySelector("p");
        const show    = txt => { if(overlay){ overlay.classList.add("active"); if(msg) msg.textContent = txt || "Generating PDF…"; } };
        const hide    = ()  => { overlay?.classList.remove("active"); };

        try {
            show("Rendering timetable…");
            await new Promise(r => setTimeout(r, 50)); // let overlay paint

            const target = document.getElementById("timetable-display");
            if(!target){ alert("Timetable not rendered yet!"); hide(); return; }

            // Force light background for clean PDF capture
            const prevScheme = document.getElementById("html-root").dataset.colorScheme;
            document.getElementById("html-root").dataset.colorScheme = "light";
            await new Promise(r => setTimeout(r, 80));

            const canvas = await html2canvas(target, {
                scale:           2,
                useCORS:         true,
                backgroundColor: "#ffffff",
                logging:         false
            });

            // Restore theme
            document.getElementById("html-root").dataset.colorScheme = prevScheme;

            show("Building PDF…");
            await new Promise(r => setTimeout(r, 30));

            const { jsPDF } = window.jspdf;
            const pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });

            const pageW  = pdf.internal.pageSize.getWidth();
            const pageH  = pdf.internal.pageSize.getHeight();
            const margin = 10;
            const usableW = pageW - margin * 2;
            const usableH = pageH - margin * 2 - 14; // 14mm header

            // ---- Header bar ----
            pdf.setFillColor(33, 128, 141);
            pdf.rect(0, 0, pageW, 14, "F");
            pdf.setTextColor(255, 255, 255);
            pdf.setFontSize(11);
            pdf.setFont("helvetica", "bold");
            pdf.text("Automated Timetable Generator", margin, 9);
            pdf.setFontSize(8);
            pdf.setFont("helvetica", "normal");
            const dateStamp = new Date().toLocaleDateString("en-IN", {
                weekday:"long", year:"numeric", month:"long", day:"numeric"
            });
            pdf.text(`Generated: ${dateStamp}`, pageW - margin, 9, { align:"right" });

            // ---- Timetable image ----
            const imgData  = canvas.toDataURL("image/jpeg", 0.92);
            const imgW     = canvas.width;
            const imgH     = canvas.height;
            const ratio    = Math.min(usableW / imgW, usableH / imgH);
            const drawW    = imgW * ratio;
            const drawH    = imgH * ratio;
            const offsetX  = margin + (usableW - drawW) / 2;
            const offsetY  = 14 + margin / 2;

            pdf.addImage(imgData, "JPEG", offsetX, offsetY, drawW, drawH);

            // ---- Footer ----
            pdf.setFillColor(245, 245, 245);
            pdf.rect(0, pageH - 8, pageW, 8, "F");
            pdf.setTextColor(100, 110, 120);
            pdf.setFontSize(7);
            pdf.text("© Automated Timetable Generator", margin, pageH - 2.5);
            pdf.text(`Page 1 of 1`, pageW - margin, pageH - 2.5, { align:"right" });

            pdf.save(`timetable_${formatDDMM(new Date())}.pdf`);
            this.logActivity("Timetable exported as PDF");

        } catch(err){
            console.error("PDF export failed:", err);
            alert("PDF export failed. Please try the Print option instead.\n\nError: " + err.message);
        } finally {
            hide();
        }
    }

    // ============================================================
    //  FEATURE 5 — DATA PERSISTENCE  (localStorage)
    //  Auto-saves after every add / edit / delete.
    //  Restores on page load.
    // ============================================================
    saveToStorage(manual = false){
        try {
            localStorage.setItem("tt_subjects",  JSON.stringify(this.subjects));
            localStorage.setItem("tt_teachers",  JSON.stringify(this.teachers));
            localStorage.setItem("tt_classes",   JSON.stringify(this.classes));
            localStorage.setItem("tt_holidays",  JSON.stringify(this.customHolidays));
            localStorage.setItem("tt_theme",     document.getElementById("html-root").dataset.colorScheme || "dark");
            if(this._appliedPalette) localStorage.setItem("tt_palette", this._appliedPalette);
            const now = new Date().toLocaleTimeString("en-IN", { hour:"2-digit", minute:"2-digit" });
            this._setSavedIndicator(`✅ Saved at ${now}`, "saved");
            if(manual) this.logActivity("Data saved manually");
        } catch(e){
            this._setSavedIndicator("⚠ Save failed (storage may be full)", "");
        }
    }

    loadFromStorage(){
        try {
            const subjects  = localStorage.getItem("tt_subjects");
            const teachers  = localStorage.getItem("tt_teachers");
            const classes   = localStorage.getItem("tt_classes");
            const holidays  = localStorage.getItem("tt_holidays");
            const theme     = localStorage.getItem("tt_theme");

            if(subjects)  this.subjects        = JSON.parse(subjects);
            if(teachers)  this.teachers        = JSON.parse(teachers);
            if(classes)   this.classes         = JSON.parse(classes);
            if(holidays)  this.customHolidays  = JSON.parse(holidays);
            const palette = localStorage.getItem("tt_palette");
            if(palette)   this._appliedPalette = palette;

            // Apply saved theme
            if(theme){
                document.getElementById("html-root").dataset.colorScheme = theme;
                const btn = document.getElementById("theme-toggle-btn");
                if(btn) btn.textContent = theme === "light" ? "🌙" : "☀️";
            }

            // Refresh all rendered views
            this.renderSubjects();
            this.renderTeachers();
            this.renderClasses();
            this.renderRoomStats();
            this.renderCustomHolidays();
            this.updateTeacherSubjectOptions();

            const hasData = this.subjects.length || this.teachers.length || this.classes.length;
            if(hasData){
                const now = new Date().toLocaleTimeString("en-IN", { hour:"2-digit", minute:"2-digit" });
                this._setSavedIndicator(`✅ Data restored at ${now}`, "saved");
                this.logActivity(`Data loaded from storage (${this.subjects.length} subjects, ${this.teachers.length} teachers, ${this.classes.length} rooms)`);
            } else {
                this._setSavedIndicator("No saved data found.", "");
            }
        } catch(e){
            this._setSavedIndicator("⚠ Could not load saved data.", "");
        }
    }

    /** Update the small "last saved" line on the Dashboard */
    _setSavedIndicator(text, cls){
        const el = document.getElementById("last-saved-indicator");
        if(!el) return;
        el.textContent = text;
        el.className   = cls;
    }

    /** Auto-save wrapper — call this at the end of every mutation */
    _autoSave(){
        this._setSavedIndicator("💾 Saving…", "saving");
        clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => this.saveToStorage(), 600);
    }

    // ============================================================
    //  FEATURE — COLOR PALETTE PRESETS
    //  8 hand-curated palettes, each with 12 distinct colors.
    //  Clicking a palette instantly re-colors all subjects.
    // ============================================================
    setupPalettes(){
        // Render on first visit to the Generate tab
        // (also called in setupTabs on every Generate tab click)
        this.renderPaletteGrid();
    }

    get COLOR_PALETTES(){
        return [
            {
                id:   "ocean",
                name: "🌊 Ocean Breeze",
                desc: "Crisp blues & teals",
                colors: ["#0077B6","#00B4D8","#48CAE4","#0096C7","#023E8A",
                         "#2196F3","#1565C0","#5E92F3","#26C6DA","#00ACC1","#4DD0E1","#80DEEA"]
            },
            {
                id:   "pastel",
                name: "🍬 Pastel Soft",
                desc: "Gentle, easy on the eyes",
                colors: ["#BEDAE3","#C4E9DA","#FED5CF","#F1B598","#D3C7E6",
                         "#FAD4A3","#B5D5C5","#F9BEBB","#E8C5E5","#C8D8E8","#FDDCB5","#D5E8D4"]
            },
            {
                id:   "tropical",
                name: "🌺 Tropical",
                desc: "Warm & vibrant",
                colors: ["#FF6B6B","#FFA07A","#FFD370","#8AC7AD","#4ECDC4",
                         "#45B7D1","#96CEB4","#FFEAA7","#F75A3B","#3F4EB5","#DDA0DD","#98D8C8"]
            },
            {
                id:   "lofi",
                name: "💜 Lofi Purple",
                desc: "Calm muted purples",
                colors: ["#674AB3","#A348A6","#9F63C4","#9075D8","#CEA2D7",
                         "#8B5CF6","#7C3AED","#C084FC","#A855F7","#E879F9","#F0ABFC","#D946EF"]
            },
            {
                id:   "forest",
                name: "🌿 Forest",
                desc: "Natural greens & earth",
                colors: ["#2D6A4F","#40916C","#52B788","#74C69D","#95D5B2",
                         "#1B4332","#52796F","#84A98C","#CAD2C5","#354F52","#A8DADC","#457B9D"]
            },
            {
                id:   "vivid",
                name: "🔥 Vivid",
                desc: "High contrast, bold",
                colors: ["#E63946","#F4A261","#2A9D8F","#264653","#E9C46A",
                         "#6D6875","#B5838D","#FF6B35","#C77DFF","#7B2D8B","#00B4D8","#E76F51"]
            },
            {
                id:   "candy",
                name: "🍭 Candy",
                desc: "Playful pinks & mints",
                colors: ["#FF85A1","#FF4D6D","#C77DFF","#80FFDB","#72EFDD",
                         "#E8ADB6","#CBADCC","#F9D9E1","#A0ACC6","#FFB3C1","#64DFDF","#48BFE3"]
            },
            {
                id:   "sunset",
                name: "🌅 Sunset",
                desc: "Warm dusk gradients",
                colors: ["#FF595E","#FF924C","#FFCA3A","#8AC926","#1982C4",
                         "#6A4C93","#FF7B9C","#FFC8DD","#BDE0FE","#A2D2FF","#FFAFCC","#CDB4DB"]
            }
        ];
    }

    renderPaletteGrid(){
        const grid = document.getElementById("palette-grid");
        const note = document.getElementById("subject-count-note");
        if(!grid) return;

        const count = this.subjects.length;

        if(note){
            if(count === 0){
                note.textContent = "⚠ Add subjects first, then apply a palette to color them all at once.";
            } else {
                note.textContent = `You have ${count} subject${count>1?"s":""} — all palettes have 12 colors, enough for up to 12 subjects.`;
            }
        }

        const applied = this._appliedPalette || null;

        grid.innerHTML = "";
        this.COLOR_PALETTES.forEach(palette => {
            const card = document.createElement("div");
            card.className = "palette-card" + (applied === palette.id ? " applied" : "");
            card.title = `Apply "${palette.name}" palette`;

            // Show first 10 color swatches as dots
            const dots = palette.colors.slice(0, 10).map(c =>
                `<span class="palette-swatch-dot" style="background:${c}" title="${c}"></span>`
            ).join("");

            card.innerHTML = `
                <div class="palette-card-name">${palette.name}</div>
                <div style="font-size:0.74em;color:var(--color-text-secondary);margin-bottom:7px">${palette.desc}</div>
                <div class="palette-swatches">${dots}</div>
                <button class="palette-apply-btn">${applied === palette.id ? "✓ Applied" : "Apply to Subjects"}</button>
            `;
            card.addEventListener("click", () => this.applyPalette(palette));
            grid.appendChild(card);
        });
    }

    applyPalette(palette){
        if(this.subjects.length === 0){
            alert("Please add subjects first before applying a palette!"); return;
        }
        // Assign palette colors cyclically
        this.subjects.forEach((s, i) => {
            s.color = palette.colors[i % palette.colors.length];
        });
        this._appliedPalette = palette.id;

        // Refresh subjects table to show new colors
        this.renderSubjects();
        this.renderPaletteGrid();

        // ← KEY FIX: re-render existing timetable with new colors without regenerating
        if(this.timetable){
            this.displayTimetable(this.timetable);
        }

        this._autoSave();
        this.logActivity(`Palette "${palette.name}" applied to ${this.subjects.length} subjects`);
        this._showToast(`✓ "${palette.name}" applied — timetable updated instantly`);
    }

    _showToast(msg){
        let toast = document.getElementById("tt-toast");
        if(!toast){
            toast = document.createElement("div");
            toast.id = "tt-toast";
            toast.style.cssText = `
                position:fixed; bottom:24px; left:50%; transform:translateX(-50%);
                background:var(--color-primary); color:#fff;
                padding:10px 22px; border-radius:24px; font-size:0.88em; font-weight:600;
                box-shadow:0 4px 16px rgba(0,0,0,0.25); z-index:9998;
                transition:opacity 0.3s; pointer-events:none;
            `;
            document.body.appendChild(toast);
        }
        toast.textContent = msg;
        toast.style.opacity = "1";
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => { toast.style.opacity = "0"; }, 2500);
    }

    // ============================================================
    //  FEATURE 7 — DARK / LIGHT MODE TOGGLE
    //  Persists choice to localStorage via saveToStorage.
    // ============================================================
    setupTheme(){
        const btn  = document.getElementById("theme-toggle-btn");
        const root = document.getElementById("html-root");
        if(!btn || !root) return;

        const apply = (scheme) => {
            root.dataset.colorScheme = scheme;
            btn.textContent          = scheme === "light" ? "🌙" : "☀️";
            btn.title                = scheme === "light" ? "Switch to dark mode" : "Switch to light mode";
        };

        // Apply any stored preference immediately (before loadFromStorage runs)
        const stored = localStorage.getItem("tt_theme");
        if(stored) apply(stored);

        btn.addEventListener("click", () => {
            const current = root.dataset.colorScheme || "dark";
            const next    = current === "dark" ? "light" : "dark";
            apply(next);
            localStorage.setItem("tt_theme", next);
            this.logActivity(`Theme switched to ${next} mode`);
        });
    }
}

// ============================================================
//  AUTO-SAVE PATCH
//  Monkey-patch every mutation method AFTER the class is defined
//  so _autoSave() is called after each add/edit/delete.
// ============================================================
const _autoSavePatch = ["addSubject","deleteSubject","editSubject",
                        "addTeacher","deleteTeacher","editTeacher",
                        "addClass","deleteClass","editClass",
                        "addCustomHoliday","removeCustomHoliday"];

// ============================================================
//  Boot
// ============================================================
const app = new TimetableApp();
window.app = app;

// Patch auto-save onto the live instance after construction
_autoSavePatch.forEach(method => {
    const original = app[method].bind(app);
    app[method] = function(...args){
        const result = original(...args);
        // schedule auto-save only if the method didn't throw
        app._autoSave();
        return result;
    };
});
