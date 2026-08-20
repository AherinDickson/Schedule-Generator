// Quarterly Sunday Schedule Generator — New
// Pipeline: future dates → lead teachers → fill remaining (shuffle + full cycle before reuse)
// Placement: explicit CSV blockouts (exact Sunday only) + min weeks between assignment anchors
// (previous dates, future file dates, usage this run). Future rows skip gap but respect blockout.

class QuarterlyScheduler {
    constructor() {
        this.volunteers = [];
        this.schedule = [];
        this.quarterStartDate = null;
        this.quarterEndDate = null;
        this.sundays = [];
        this.volunteerUsage = {};
        this.violations = { threePlusUses: new Set(), insufficientGaps: {} };
        /** Minimum whole-week distance vs any anchor. */
        this.minSchedulingGapWeeks = 3;
        this.highlightsEnabled = true;
        this.lastGenerationResult = null;
        this.infeasibleVolunteers = {};
        /** @type {Set<string>} Local YYYY-MM-DD keys for Sundays with no staffing (from UI). */
        this.skipSundayDateKeys = new Set();
        /** Warnings when volunteer file future rows target a skip-Sunday (built each generate). */
        this.futureOnSkippedWarnings = [];
        /** Date/future parse failures from the last volunteer file upload. */
        this.importWarnings = [];
        this.initializeEventListeners();
    }

    cloneScheduleData() {
        return {
            schedule: JSON.parse(JSON.stringify(this.schedule)),
            volunteerUsage: JSON.parse(JSON.stringify(this.volunteerUsage)),
            violations: {
                threePlusUses: new Set(this.violations.threePlusUses),
                insufficientGaps: JSON.parse(JSON.stringify(this.violations.insufficientGaps))
            }
        };
    }

    getAssignedPositionKeysForVolunteer(entry, volunteerName) {
        const p = entry.positions || {};
        const keys = [];
        if (p.checkInCoordinator === volunteerName) keys.push('checkInCoordinator');
        if ((p.crawlers || []).includes(volunteerName)) keys.push('crawlers');
        if ((p.toddler1 || []).includes(volunteerName)) keys.push('toddler1');
        if ((p.toddler2 || []).includes(volunteerName)) keys.push('toddler2');
        if ((p.preK1 || []).includes(volunteerName)) keys.push('preK1');
        if ((p.preK2 || []).includes(volunteerName)) keys.push('preK2');
        if (p.toddler2LeadTeacher === volunteerName) keys.push('toddler2LeadTeacher');
        if (p.preK1LeadTeacher === volunteerName) keys.push('preK1LeadTeacher');
        if (p.preK2LeadTeacher === volunteerName) keys.push('preK2LeadTeacher');
        return keys;
    }

    countRequiredSlotBlanks(schedule) {
        const listCaps = [
            ['crawlers', 3],
            ['toddler1', 2],
            ['toddler2', 2],
            ['preK1', 2],
            ['preK2', 2]
        ];
        const leadKeys = ['checkInCoordinator', 'toddler2LeadTeacher', 'preK1LeadTeacher', 'preK2LeadTeacher'];
        let blanks = 0;
        (schedule || []).forEach((entry) => {
            if (entry.skipStaffing) return;
            const p = entry.positions || {};
            leadKeys.forEach((key) => {
                if (!p[key]) blanks++;
            });
            listCaps.forEach(([key, cap]) => {
                const filled = Array.isArray(p[key]) ? p[key].filter((n) => n).length : 0;
                blanks += Math.max(0, cap - filled);
            });
        });
        return blanks;
    }

    scoreScheduleData(data) {
        const schedule = data.schedule || [];
        const usage = data.volunteerUsage || {};
        const violations = data.violations || { threePlusUses: new Set(), insufficientGaps: {} };
        const allNames = this.volunteers.map((v) => v.name);
        const feasibleNames = allNames.filter((n) => !this.infeasibleVolunteers[n]);
        const usageCounts = feasibleNames.map((n) => (usage[n] ? usage[n].count : 0));
        const usedCounts = usageCounts.filter((c) => c > 0);

        const unusedCount = usageCounts.filter((c) => c === 0).length;
        const fourPlusCount = usageCounts.filter((c) => c >= 4).length;
        const gapViolationCount = Object.keys(violations.insufficientGaps || {}).length;
        const blankCount = this.countRequiredSlotBlanks(schedule);

        const violationCount = fourPlusCount + gapViolationCount + unusedCount + blankCount;
        const violationScore = Math.max(0, 100 - violationCount * 8);

        // DEV-like fairness: variance among used volunteers.
        let fairnessScore = 0;
        if (usedCounts.length > 0) {
            const avgUsage = usedCounts.reduce((a, b) => a + b, 0) / usedCounts.length;
            const variance = usedCounts.reduce((sum, count) => sum + Math.pow(count - avgUsage, 2), 0) / usedCounts.length;
            fairnessScore = Math.max(0, 100 - variance * 10);
        }

        // DEV-like preference score: of used volunteers with preferences, count if any preference was met.
        let volunteersWithPreferences = 0;
        let volunteersWithPreferencesSatisfied = 0;
        this.volunteers.forEach((volunteer) => {
            const pref = volunteer.normalizedPreferences || new Set();
            const usageCount = usage[volunteer.name]?.count || 0;
            if (pref.size > 0 && usageCount > 0) {
                volunteersWithPreferences++;
                let matched = false;
                for (const entry of schedule) {
                    const assigned = this.getAssignedPositionKeysForVolunteer(entry, volunteer.name);
                    if (assigned.some((k) => pref.has(k))) {
                        matched = true;
                        break;
                    }
                }
                if (matched) volunteersWithPreferencesSatisfied++;
            }
        });
        const preferenceScore =
            volunteersWithPreferences > 0
                ? (volunteersWithPreferencesSatisfied / volunteersWithPreferences) * 100
                : 100;

        // DEV-like gap quality score: prefer larger valid gaps.
        const gaps = [];
        this.volunteers.forEach((volunteer) => {
            const usageDates = (usage[volunteer.name]?.dates || []).map((d) => new Date(d));
            const ownDates = [
                ...(volunteer.previouslyScheduledDates || []),
                ...usageDates
            ];
            const uniq = [];
            const seen = new Set();
            ownDates.forEach((d) => {
                const t = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
                if (!seen.has(t)) {
                    seen.add(t);
                    uniq.push(new Date(d.getFullYear(), d.getMonth(), d.getDate()));
                }
            });
            uniq.sort((a, b) => a - b);
            for (let i = 1; i < uniq.length; i++) {
                const g = this.weeksBetween(uniq[i - 1], uniq[i]);
                if (g > this.minSchedulingGapWeeks) gaps.push(g);
            }
        });
        const avgGap = gaps.length > 0 ? gaps.reduce((a, b) => a + b, 0) / gaps.length : this.minSchedulingGapWeeks;
        const excessGap = avgGap - this.minSchedulingGapWeeks;
        const gapQualityScore = Math.min(
            100,
            Math.max(0, (excessGap / this.minSchedulingGapWeeks) * 50 + 50)
        );

        const total =
            violationScore * 0.4 +
            fairnessScore * 0.3 +
            preferenceScore * 0.15 +
            gapQualityScore * 0.15;

        return {
            total: Math.min(100, Math.max(0, total)),
            violationScore,
            fairnessScore,
            preferenceScore,
            gapQualityScore,
            violationCount,
            unusedCount,
            fourPlusCount,
            gapViolationCount,
            blankCount
        };
    }

    assessVolunteerFeasibility() {
        const violatesStaticAnchorsOnly = (volunteer, candidateDate) => {
            const anchors = [
                ...(volunteer.previouslyScheduledDates || []),
                ...(volunteer.futureScheduledDates || []).map((f) => f.date)
            ];
            for (const anchor of anchors) {
                if (this.isSameDate(candidateDate, anchor)) continue;
                if (this.weeksBetween(candidateDate, anchor) <= this.minSchedulingGapWeeks) {
                    return true;
                }
            }
            return false;
        };

        const infeasible = {};
        this.volunteers.forEach((v) => {
            const staffedSundays = this.sundays.filter((date) => !this.isSundaySkipped(date));
            const usableDates = staffedSundays.filter((date) =>
                !this.isExplicitBlockout(v, date) &&
                !violatesStaticAnchorsOnly(v, date)
            );
            if (usableDates.length === 0) {
                infeasible[v.name] = {
                    reason: 'No usable dates (blocked by blockouts and/or min-gap anchors).'
                };
            }
        });
        this.infeasibleVolunteers = infeasible;
    }

    generateMultipleSchedules(count = 10) {
        const runs = [];
        for (let i = 0; i < count; i++) {
            this.generateSingleSchedule();
            const data = this.cloneScheduleData();
            const score = this.scoreScheduleData(data);
            runs.push({ index: i, data, score });
        }
        runs.sort((a, b) => b.score.total - a.score.total);
        const best = runs[0];
        this.schedule = best.data.schedule.map((entry) => ({
            ...entry,
            date: new Date(entry.date),
            skipStaffing: !!entry.skipStaffing
        }));
        this.volunteerUsage = {};
        Object.entries(best.data.volunteerUsage).forEach(([name, usage]) => {
            this.volunteerUsage[name] = {
                ...usage,
                dates: (usage.dates || []).map((d) => new Date(d))
            };
        });
        const restoredInsufficientGaps = {};
        Object.entries(best.data.violations.insufficientGaps || {}).forEach(([name, pairs]) => {
            restoredInsufficientGaps[name] = pairs.map((pair) => ({
                ...pair,
                date1: new Date(pair.date1),
                date2: new Date(pair.date2)
            }));
        });
        this.violations = {
            threePlusUses: new Set(best.data.violations.threePlusUses),
            insufficientGaps: restoredInsufficientGaps
        };
        const topRuns = runs.slice(0, 3).map((r) => ({
            index: r.index,
            score: r.score
        }));
        this.lastGenerationResult = {
            attemptCount: count,
            bestIndex: best.index,
            bestScore: best.score,
            topRuns
        };
        return { bestIndex: best.index, bestScore: best.score, runs, topRuns };
    }

    initializeEventListeners() {
        const fileInput = document.getElementById('fileInput');
        const uploadArea = document.getElementById('uploadArea');
        const generateBtn = document.getElementById('generateBtn');
        const exportCSVBtn = document.getElementById('exportCSVBtn');
        const exportJSONBtn = document.getElementById('exportJSONBtn');
        const printBtn = document.getElementById('printBtn');

        uploadArea.addEventListener('click', () => fileInput && fileInput.click());

        uploadArea.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            uploadArea.classList.add('dragover');
        });
        uploadArea.addEventListener('dragleave', (e) => {
            e.preventDefault();
            e.stopPropagation();
            uploadArea.classList.remove('dragover');
        });
        uploadArea.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            uploadArea.classList.remove('dragover');
            const file = e.dataTransfer.files[0];
            if (file) this.handleFileUpload(file);
        });

        fileInput.addEventListener('change', (e) => {
            if (e.target.files && e.target.files[0]) {
                this.handleFileUpload(e.target.files[0]);
            }
        });

        generateBtn.addEventListener('click', () => this.generateSchedule());
        exportCSVBtn.addEventListener('click', () => this.exportToCSV());
        exportJSONBtn.addEventListener('click', () => this.exportToJSON());
        printBtn.addEventListener('click', () => window.print());

        const quarterEl = document.getElementById('quarter');
        const yearEl = document.getElementById('year');
        if (quarterEl) quarterEl.addEventListener('change', () => this.renderSkipWeeksCheckboxes());
        if (yearEl) yearEl.addEventListener('change', () => this.renderSkipWeeksCheckboxes());

        document.getElementById('skipWeeksSelectAll')?.addEventListener('click', () => {
            document.querySelectorAll('#skipWeeksList input[data-skip-date]').forEach((el) => {
                el.checked = true;
            });
        });
        document.getElementById('skipWeeksClearAll')?.addEventListener('click', () => {
            document.querySelectorAll('#skipWeeksList input[data-skip-date]').forEach((el) => {
                el.checked = false;
            });
        });

        this.renderSkipWeeksCheckboxes();

        document.addEventListener('change', (e) => {
            if (e.target && e.target.id === 'toggleHighlights') {
                this.highlightsEnabled = !!e.target.checked;
                if (this.schedule && this.schedule.length > 0) {
                    this.displaySchedule();
                    this.displayStatistics();
                }
            }
        });
    }

    async handleFileUpload(file) {
        const fileInfo = document.getElementById('fileInfo');
        const generateBtn = document.getElementById('generateBtn');

        this.clearImportWarnings();
        fileInfo.classList.remove('hidden');
        fileInfo.innerHTML = `<p>📄 ${file.name} (${(file.size / 1024).toFixed(2)} KB)</p>`;

        // Infer quarter/year from filename as early as possible,
        // even if the selected file later fails extension validation.
        const inferred = this.inferQuarterYearFromFilename(file.name);
        if (inferred) {
            const quarterEl = document.getElementById('quarter');
            const yearEl = document.getElementById('year');
            if (quarterEl) quarterEl.value = inferred.quarter;
            if (yearEl) yearEl.value = String(inferred.year);
            this.renderSkipWeeksCheckboxes();
            fileInfo.innerHTML += `<p class="success">📅 Auto-set schedule period to ${inferred.quarter} ${inferred.year} from filename</p>`;
        }

        const lowerName = file.name.toLowerCase();
        const isCsv = lowerName.endsWith('.csv');
        const isTxt = lowerName.endsWith('.txt');
        if (!isCsv && !isTxt) {
            fileInfo.innerHTML += `<p class="error">❌ Error: Only .txt (pipe-delimited) and .csv (comma-delimited) files are supported.</p>`;
            this.volunteers = [];
            generateBtn.disabled = true;
            return;
        }

        try {
            const text = await file.text();
            const parsed = isCsv
                ? this.parseCSVFile(text)
                : this.parsePipeDelimitedFile(text);
            this.volunteers = parsed.volunteers;
            this.importWarnings = parsed.warnings || [];
            if (this.volunteers.length === 0) throw new Error('No volunteers found in file');
            const warningCount = this.importWarnings.length;
            fileInfo.innerHTML += `<p class="success">✅ Successfully loaded ${this.volunteers.length} volunteer(s)</p>`;
            if (warningCount > 0) {
                fileInfo.innerHTML += `<p class="warning">${warningCount} parse warning(s). Skipped values are listed below.</p>`;
            }
            this.displayImportWarnings();
            generateBtn.disabled = false;
        } catch (error) {
            fileInfo.innerHTML += `<p class="error">❌ Error: ${error.message}</p>`;
            this.volunteers = [];
            this.clearImportWarnings();
            generateBtn.disabled = true;
        }
    }

    clearImportWarnings() {
        this.importWarnings = [];
        const el = document.getElementById('importWarnings');
        if (!el) return;
        el.innerHTML = '';
        el.classList.add('hidden');
    }

    displayImportWarnings() {
        const el = document.getElementById('importWarnings');
        if (!el) return;
        const warnings = this.importWarnings || [];
        if (warnings.length === 0) {
            el.innerHTML = '';
            el.classList.add('hidden');
            return;
        }
        const rows = warnings.map((w) => {
            return `<tr>
                <td>${this.escapeHtml(String(w.line ?? ''))}</td>
                <td>${this.escapeHtml(w.name || '')}</td>
                <td>${this.escapeHtml(w.field || '')}</td>
                <td>${this.escapeHtml(w.value || '')}</td>
                <td>${this.escapeHtml(w.reason || '')}</td>
            </tr>`;
        }).join('');
        el.classList.remove('hidden');
        el.innerHTML = `
            <h3>Parse warnings (${warnings.length})</h3>
            <div class="import-warnings-table-wrap">
                <table class="import-warnings-table">
                    <thead>
                        <tr>
                            <th>Line</th>
                            <th>Name</th>
                            <th>Field</th>
                            <th>Value</th>
                            <th>Issue</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        `;
    }

    inferQuarterYearFromFilename(filename) {
        if (!filename) return null;
        const base = String(filename).replace(/\.[^.]+$/, '');
        const patterns = [
            /(?:^|[^a-z0-9])q([1-4])[\s_-]?(\d{4})(?=$|[^0-9])/i,
            /(?:^|[^0-9])(\d{4})[\s_-]?q([1-4])(?=$|[^a-z0-9])/i
        ];
        for (const re of patterns) {
            const m = base.match(re);
            if (!m) continue;
            const quarter = re === patterns[0] ? `Q${m[1]}` : `Q${m[2]}`;
            const year = parseInt(re === patterns[0] ? m[2] : m[1], 10);
            if (Number.isFinite(year)) {
                return { quarter, year };
            }
        }
        return null;
    }

    parsePipeDelimitedFile(text) {
        return this.parseDelimitedRows(text, (line) => line.split('|'));
    }

    parseCSVFile(text) {
        return this.parseDelimitedRows(text, (line) => this.splitCSVLine(line));
    }

    /**
     * Split a single CSV line into fields, honoring double-quoted fields
     * (which may contain commas) and "" escaped quotes.
     */
    splitCSVLine(line) {
        const fields = [];
        let field = '';
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (inQuotes) {
                if (ch === '"') {
                    if (line[i + 1] === '"') {
                        field += '"';
                        i++;
                    } else {
                        inQuotes = false;
                    }
                } else {
                    field += ch;
                }
            } else if (ch === '"') {
                inQuotes = true;
            } else if (ch === ',') {
                fields.push(field);
                field = '';
            } else {
                field += ch;
            }
        }
        fields.push(field);
        return fields;
    }

    /** Shared row parsing: splitLine extracts fields; mapping is delimiter-agnostic. */
    parseDelimitedRows(text, splitLine) {
        const lines = String(text).split('\n');
        const volunteers = [];
        const warnings = [];
        let headers = null;
        let originalHeaders = null;

        for (let i = 0; i < lines.length; i++) {
            const raw = lines[i].replace(/\r$/, '');
            if (!raw.trim()) continue;

            if (!headers) {
                originalHeaders = splitLine(raw).map((h) => h.trim());
                headers = originalHeaders.map((h) => h.toLowerCase());
                continue;
            }

            const values = splitLine(raw).map((v) => v.trim());
            if (values.length === 0 || !values[0]) continue;

            const { volunteer, warnings: rowWarnings } = this.buildVolunteerFromFields(
                headers,
                originalHeaders,
                values,
                i + 1
            );
            warnings.push(...rowWarnings);
            if (volunteer.name) volunteers.push(volunteer);
        }
        return { volunteers, warnings };
    }

    buildVolunteerFromFields(headers, originalHeaders, values, lineNumber) {
        const volunteer = {
            name: '',
            spouse: '',
            isToddlerLeadTeacher: false,
            isPreK1LeadTeacher: false,
            isPreK2LeadTeacher: false,
            isPreKLeadTeacher: false,
            blockoutDates: [],
            futureScheduledDates: [],
            previouslyScheduledDates: [],
            positionPreferences: []
        };
        const warnings = [];
        const isNameHeader = (header) => header.includes('name') || header.includes('volunteer');
        const fieldLabel = (index, header) => {
            const original = (originalHeaders[index] || '').trim();
            return original || header;
        };
        const pushParseErrors = (field, errors) => {
            errors.forEach((err) => {
                warnings.push({
                    line: lineNumber,
                    name: volunteer.name,
                    field,
                    value: err.value,
                    reason: err.reason
                });
            });
        };

        const nameIndex = headers.findIndex(isNameHeader);
        if (nameIndex >= 0) {
            volunteer.name = (values[nameIndex] || '').trim();
        }

        headers.forEach((header, index) => {
            const value = (values[index] || '').trim();
            if (isNameHeader(header)) {
                return;
            } else if (header.includes('spouse')) {
                volunteer.spouse = value;
            } else if (this.headerIsPreK1Lead(header)) {
                volunteer.isPreK1LeadTeacher = this.parseBoolean(value);
            } else if (this.headerIsPreK2Lead(header)) {
                volunteer.isPreK2LeadTeacher = this.parseBoolean(value);
            } else if (header.includes('toddler') && header.includes('lead')) {
                volunteer.isToddlerLeadTeacher = this.parseBoolean(value);
            } else if (header.includes('pre') && (header.includes('k') || header.includes('k-')) && header.includes('lead')) {
                volunteer.isPreKLeadTeacher = this.parseBoolean(value);
            } else if (header.includes('blockout') || header.includes('blackout')) {
                const parsed = this.parseDates(value);
                volunteer.blockoutDates = parsed.dates;
                pushParseErrors(fieldLabel(index, header), parsed.errors);
            } else if (header.includes('future')) {
                const parsedFuture = this.parseFutureDates(value);
                volunteer.futureScheduledDates = parsedFuture.futureScheduledDates;
                pushParseErrors(fieldLabel(index, header), parsedFuture.errors);
                // Entries without a separator in "future" are treated as explicit blockouts.
                if (parsedFuture.impliedBlockoutDates.length > 0) {
                    const seen = new Set(volunteer.blockoutDates.map((d) => d.getTime()));
                    parsedFuture.impliedBlockoutDates.forEach((d) => {
                        const t = d.getTime();
                        if (!seen.has(t)) {
                            volunteer.blockoutDates.push(d);
                            seen.add(t);
                        }
                    });
                }
            } else if (header.includes('previous') || header.includes('past')) {
                const parsed = this.parseDates(value);
                volunteer.previouslyScheduledDates = parsed.dates;
                pushParseErrors(fieldLabel(index, header), parsed.errors);
            } else if (header.includes('position') && header.includes('preference')) {
                volunteer.positionPreferences = this.parsePositionPreferences(value);
            }
        });

        return { volunteer, warnings };
    }

    headerIsPreK1Lead(header) {
        const h = header.toLowerCase();
        return (
            h.includes('lead') &&
            (h.includes('pre-k 1') || h.includes('prek 1') || h.includes('pre k 1') || h.includes('pre-k1') || h.includes('prek1'))
        );
    }

    headerIsPreK2Lead(header) {
        const h = header.toLowerCase();
        return (
            h.includes('lead') &&
            (h.includes('pre-k 2') || h.includes('prek 2') || h.includes('pre k 2') || h.includes('pre-k2') || h.includes('prek2'))
        );
    }

    /** True if volunteer is scheduled as any Pre-K lead role (including legacy single flag). */
    isAnyPreKLeadVolunteer(v) {
        return !!(v.isPreK1LeadTeacher || v.isPreK2LeadTeacher || v.isPreKLeadTeacher);
    }

    parseBoolean(value) {
        const lower = value.toLowerCase();
        return lower === 'true' || lower === 'yes' || lower === '1' || lower === 'y';
    }

    parseDates(dateString) {
        if (!dateString) return { dates: [], errors: [] };
        const dateStrings = dateString.split(/[,;\n\r]+/).map(d => d.trim()).filter(d => d.length > 0);
        const dates = [];
        const errors = [];
        dateStrings.forEach(ds => {
            const date = this.parseDate(ds);
            if (date) dates.push(date);
            else errors.push({ value: ds, reason: 'Could not parse date' });
        });
        return { dates, errors };
    }

    parseFutureDates(dateString) {
        if (!dateString) return { futureScheduledDates: [], impliedBlockoutDates: [], errors: [] };
        const items = dateString.split(/[,;\n\r]+/).map(i => i.trim()).filter(i => i.length > 0);
        const futureScheduledDates = [];
        const impliedBlockoutDates = [];
        const errors = [];
        items.forEach(item => {
            const separatorMatch = item.match(/^(.+?)[:|](.+)$/);
            if (separatorMatch) {
                const dateStr = separatorMatch[1].trim();
                const position = separatorMatch[2].trim();
                const date = this.parseDate(dateStr);
                if (date && position) futureScheduledDates.push({ date, position });
                else errors.push({ value: item, reason: 'Future entry missing position or invalid date' });
            } else {
                const date = this.parseDate(item);
                if (date) {
                    impliedBlockoutDates.push(date);
                } else {
                    errors.push({ value: item, reason: 'Future entry missing position or invalid date' });
                }
            }
        });
        return { futureScheduledDates, impliedBlockoutDates, errors };
    }

    parsePositionPreferences(prefString) {
        if (!prefString) return [];
        return prefString
            .split(',')
            .map(p => p.trim())
            .filter(p => p.length > 0);
    }

    parseDate(dateString) {
        if (!dateString) return null;
        const formats = [
            /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
            /^(\d{4})-(\d{1,2})-(\d{1,2})$/,
            /^(\d{1,2})-(\d{1,2})-(\d{4})$/
        ];
        for (const format of formats) {
            const match = dateString.match(format);
            if (match) {
                let month, day, year;
                if (format === formats[1]) {
                    year = parseInt(match[1]);
                    month = parseInt(match[2]) - 1;
                    day = parseInt(match[3]);
                } else {
                    month = parseInt(match[1]) - 1;
                    day = parseInt(match[2]);
                    year = parseInt(match[3]);
                }
                const date = new Date(year, month, day);
                if (!isNaN(date.getTime())) return date;
            }
        }
        return null;
    }

    getQuarterDates(quarter, year) {
        let startMonth, endMonth;
        switch (quarter) {
            case 'Q1': startMonth = 0; endMonth = 2; break;
            case 'Q2': startMonth = 3; endMonth = 5; break;
            case 'Q3': startMonth = 6; endMonth = 8; break;
            case 'Q4': startMonth = 9; endMonth = 11; break;
        }
        const startDate = new Date(year, startMonth, 1);
        const endDate = new Date(year, endMonth + 1, 0);
        return { startDate, endDate };
    }

    getSundaysInQuarter(startDate, endDate) {
        const sundays = [];
        const current = new Date(startDate);
        while (current.getDay() !== 0 && current <= endDate) {
            current.setDate(current.getDate() + 1);
        }
        while (current <= endDate) {
            sundays.push(new Date(current));
            current.setDate(current.getDate() + 7);
        }
        return sundays;
    }

    isDateInQuarter(date, quarterStart, quarterEnd) {
        return date >= quarterStart && date <= quarterEnd;
    }

    isSunday(date) {
        return date.getDay() === 0;
    }

    isSameDate(date1, date2) {
        return (
            date1.getFullYear() === date2.getFullYear() &&
            date1.getMonth() === date2.getMonth() &&
            date1.getDate() === date2.getDate()
        );
    }

    /** Stable local calendar key for matching skip UI to schedule rows. */
    dateKeyLocal(date) {
        const d = date instanceof Date ? date : new Date(date);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    }

    getSkipSundayKeysFromDOM() {
        const listEl = document.getElementById('skipWeeksList');
        if (!listEl) return new Set();
        const keys = new Set();
        listEl.querySelectorAll('input[type="checkbox"][data-skip-date]:checked').forEach((el) => {
            keys.add(el.getAttribute('data-skip-date'));
        });
        return keys;
    }

    isSundaySkipped(date) {
        if (!this.skipSundayDateKeys || this.skipSundayDateKeys.size === 0) return false;
        return this.skipSundayDateKeys.has(this.dateKeyLocal(date));
    }

    buildFutureOnSkippedWarnings() {
        const warnings = [];
        const skip = this.skipSundayDateKeys;
        if (!skip || skip.size === 0) return warnings;
        this.volunteers.forEach((v) => {
            (v.futureScheduledDates || []).forEach((f) => {
                const key = this.dateKeyLocal(f.date);
                if (skip.has(key)) {
                    const ds = f.date.toLocaleDateString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric'
                    });
                    warnings.push(
                        `${v.name}: future file assigns "${f.position}" on ${ds}, but that Sunday is marked no volunteers — not applied.`
                    );
                }
            });
        });
        return warnings;
    }

    renderSkipWeeksCheckboxes() {
        const listEl = document.getElementById('skipWeeksList');
        const quarterEl = document.getElementById('quarter');
        const yearEl = document.getElementById('year');
        if (!listEl || !quarterEl || !yearEl) return;

        const prevChecked = new Set();
        listEl.querySelectorAll('input[data-skip-date]:checked').forEach((inp) => {
            prevChecked.add(inp.getAttribute('data-skip-date'));
        });

        const quarter = quarterEl.value;
        const year = parseInt(yearEl.value, 10);
        if (!Number.isFinite(year)) {
            listEl.innerHTML = '';
            return;
        }
        const { startDate, endDate } = this.getQuarterDates(quarter, year);
        const sundays = this.getSundaysInQuarter(startDate, endDate);

        const frag = document.createDocumentFragment();
        sundays.forEach((d) => {
            const key = this.dateKeyLocal(d);
            const label = document.createElement('label');
            label.className = 'skip-weeks-item';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.setAttribute('data-skip-date', key);
            if (prevChecked.has(key)) cb.checked = true;
            label.appendChild(cb);
            const text = ` ${d.toLocaleDateString('en-US', {
                weekday: 'short',
                month: 'short',
                day: 'numeric',
                year: 'numeric'
            })}`;
            label.appendChild(document.createTextNode(text));
            frag.appendChild(label);
        });
        listEl.innerHTML = '';
        listEl.appendChild(frag);
    }

    escapeHtml(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /** Calendar weeks between two dates (Schedule Generator — DEV parity). */
    weeksBetween(date1, date2) {
        const diffTime = Math.abs(date2 - date1);
        return Math.ceil(diffTime / (1000 * 60 * 60 * 24 * 7));
    }

    /** CSV blockout/blackout: exact Sunday only (no gap spread). */
    isExplicitBlockout(volunteer, date) {
        return (volunteer.blockoutDates || []).some((d) => this.isSameDate(d, date));
    }

    /** Assignment anchors for min-gap (blockouts are not anchors). Deduplicated by calendar day. */
    collectGapAnchorDates(volunteer) {
        const byTime = new Map();
        const add = (d) => {
            if (!d) return;
            const normalized = new Date(d.getFullYear(), d.getMonth(), d.getDate());
            byTime.set(normalized.getTime(), normalized);
        };
        for (const d of volunteer.previouslyScheduledDates || []) add(d);
        for (const f of volunteer.futureScheduledDates || []) add(f.date);
        const usage = this.volunteerUsage[volunteer.name];
        if (usage && usage.dates) {
            for (const d of usage.dates) add(d);
        }
        return Array.from(byTime.values());
    }

    /** True if candidate is too close to any anchor (same day as an anchor is allowed). */
    violatesMinGap(volunteer, candidateDate, minGapWeeks) {
        for (const anchor of this.collectGapAnchorDates(volunteer)) {
            if (this.isSameDate(candidateDate, anchor)) continue;
            if (this.weeksBetween(candidateDate, anchor) <= minGapWeeks) return true;
        }
        return false;
    }

    /**
     * Single gate for placements. future = mandatory row unless explicit blockout (gap ignored).
     * algorithm = leads/fill: blockout or min-gap vs anchors fails.
     */
    canPlaceVolunteerOnDate(volunteer, date, options = {}) {
        const purpose = options.purpose || 'algorithm';
        const minGapWeeks = Number.isFinite(options.minGapWeeks)
            ? options.minGapWeeks
            : this.minSchedulingGapWeeks;
        if (this.isExplicitBlockout(volunteer, date)) return false;
        if (purpose === 'future') return true;
        if (this.violatesMinGap(volunteer, date, minGapWeeks)) return false;
        return true;
    }

    /** Fisher–Yates shuffle (mutates copy) */
    shuffle(array) {
        const a = [...array];
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
    }

    /**
     * Pick next volunteer in fixed order; each name used at most once per cycle.
     * Reset cycle when everyone has had a turn (or after one full pass with no pick).
     * If two passes yield no eligible pick, return null (slot may stay blank).
     */
    pickWithCycle(order, cycleState, isEligible) {
        const used = cycleState.usedInCycle;
        for (let pass = 0; pass < 2; pass++) {
            for (const v of order) {
                if (used.has(v.name)) continue;
                if (!isEligible(v)) continue;
                used.add(v.name);
                return v;
            }
            used.clear();
        }
        return null;
    }

    recordVolunteerUsage(name, date) {
        if (!this.volunteerUsage[name]) {
            this.volunteerUsage[name] = { count: 0, dates: [], cycles: 0 };
        }
        this.volunteerUsage[name].count++;
        this.volunteerUsage[name].dates.push(new Date(date));
    }

    isVolunteerNameOnEntry(name, entry) {
        if (!name) return false;
        const p = entry.positions;
        if (p.checkInCoordinator === name) return true;
        if (p.crawlers.includes(name)) return true;
        if (p.toddler1.includes(name)) return true;
        if (p.toddler2.includes(name)) return true;
        if (p.preK1.includes(name)) return true;
        if (p.preK2.includes(name)) return true;
        if (p.toddler2LeadTeacher === name) return true;
        if (p.preK1LeadTeacher === name) return true;
        if (p.preK2LeadTeacher === name) return true;
        return false;
    }

    removeVolunteerUsage(name, date) {
        if (!this.volunteerUsage[name]) return;
        this.volunteerUsage[name].count = Math.max(0, this.volunteerUsage[name].count - 1);
        const t = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
        this.volunteerUsage[name].dates = this.volunteerUsage[name].dates.filter(
            (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() !== t
        );
    }

    normalizePreferenceLabel(label) {
        const l = String(label || '').toLowerCase().replace(/\s+/g, ' ').trim();
        if (!l) return [];
        if (l.includes('check')) return ['checkInCoordinator'];
        if (l.includes('crawler') || l.includes('lap')) return ['crawlers'];
        if (l.includes('toddler') && l.includes('lead')) return ['toddler2LeadTeacher'];
        if (l.includes('toddler') && (l.includes('1') || l.includes('one'))) return ['toddler1'];
        if (l.includes('toddler') && (l.includes('2') || l.includes('two'))) return ['toddler2'];
        if (l.includes('toddler')) return ['toddler1', 'toddler2'];
        const isPreK = l.includes('pre') && (l.includes('k') || l.includes('k-') || l.includes('k '));
        if (isPreK && l.includes('lead')) {
            if (l.includes('1')) return ['preK1LeadTeacher'];
            if (l.includes('2')) return ['preK2LeadTeacher'];
            return ['preK1LeadTeacher', 'preK2LeadTeacher'];
        }
        if (isPreK && l.includes('1')) return ['preK1'];
        if (isPreK && l.includes('2')) return ['preK2'];
        if (isPreK) return ['preK1', 'preK2'];
        return [];
    }

    enrichVolunteerPreferences(volunteer) {
        const normalized = new Set();
        (volunteer.positionPreferences || []).forEach((p) => {
            this.normalizePreferenceLabel(p).forEach((key) => normalized.add(key));
        });
        const generalKeys = ['checkInCoordinator', 'crawlers', 'toddler1', 'toddler2', 'preK1', 'preK2'];
        const hasAllGeneral = generalKeys.every((k) => normalized.has(k));
        volunteer.normalizedPreferences = normalized;
        volunteer.isGeneralPreferenceWildcard = hasAllGeneral;
    }

    positionAllowedByPreference(volunteer, positionKey) {
        const pref = volunteer.normalizedPreferences || new Set();
        if (pref.size === 0) return true;
        if (volunteer.isGeneralPreferenceWildcard) return true;
        return pref.has(positionKey);
    }

    isVolunteerScheduledOnEntry(name, scheduleEntry) {
        return this.isVolunteerNameOnEntry(name, scheduleEntry);
    }

    removeReplacedTeacherSpouse(replacedTeacherName, scheduleEntry) {
        const replacedVolunteer = this.volunteers.find((v) => v.name === replacedTeacherName);
        if (!replacedVolunteer || !replacedVolunteer.spouse) return;
        const spouseName = replacedVolunteer.spouse;
        const p = scheduleEntry.positions;
        if (p.checkInCoordinator === spouseName) {
            this.removeVolunteerUsage(spouseName, scheduleEntry.date);
            p.checkInCoordinator = null;
            return;
        }
        for (const listKey of ['crawlers', 'toddler1', 'toddler2', 'preK1', 'preK2']) {
            const idx = p[listKey].indexOf(spouseName);
            if (idx !== -1) {
                this.removeVolunteerUsage(spouseName, scheduleEntry.date);
                p[listKey].splice(idx, 1);
                return;
            }
        }
    }

    canSpouseBeScheduledOnDate(spouseName, scheduleEntry, excludeSet = null, targetPosition = null, minGapWeeks = null) {
        const spouse = this.volunteers.find((v) => v.name === spouseName);
        if (!spouse) return false;
        if (excludeSet && excludeSet.has(spouse.name)) return true;
        if (this.isVolunteerScheduledOnEntry(spouse.name, scheduleEntry)) return true;
        const gapWeeks = Number.isFinite(minGapWeeks) ? minGapWeeks : this.minSchedulingGapWeeks;
        if (!this.canPlaceVolunteerOnDate(spouse, scheduleEntry.date, { purpose: 'algorithm', minGapWeeks: gapWeeks })) {
            return false;
        }

        const p = scheduleEntry.positions;
        if (spouse.isToddlerLeadTeacher && !p.toddler2LeadTeacher) return true;
        if ((spouse.isPreK1LeadTeacher || spouse.isPreKLeadTeacher) && !p.preK1LeadTeacher) return true;
        if ((spouse.isPreK2LeadTeacher || spouse.isPreKLeadTeacher) && !p.preK2LeadTeacher) return true;
        if (!p.checkInCoordinator) return true;
        if (p.crawlers.length < 3) return true;
        if (p.toddler1.length < 2 && this.positionAllowedByPreference(spouse, 'toddler1')) return true;
        if (p.toddler2.length < 2 && this.positionAllowedByPreference(spouse, 'toddler2')) return true;
        if (p.preK1.length < 2 && this.positionAllowedByPreference(spouse, 'preK1')) return true;
        if (p.preK2.length < 2 && this.positionAllowedByPreference(spouse, 'preK2')) return true;

        if (targetPosition && (spouse.isToddlerLeadTeacher || spouse.isPreK1LeadTeacher || spouse.isPreK2LeadTeacher || spouse.isPreKLeadTeacher)) {
            return true;
        }
        return false;
    }

    scheduleSpouseOnSameDateStrict(spouseName, scheduleEntry, excludeSet = null, targetPosition = null, minGapWeeks = null) {
        const spouse = this.volunteers.find((v) => v.name === spouseName);
        if (!spouse) return false;
        if (this.isVolunteerScheduledOnEntry(spouse.name, scheduleEntry)) return true;
        const gapWeeks = Number.isFinite(minGapWeeks) ? minGapWeeks : this.minSchedulingGapWeeks;
        if (!this.canPlaceVolunteerOnDate(spouse, scheduleEntry.date, { purpose: 'algorithm', minGapWeeks: gapWeeks })) {
            return false;
        }

        const p = scheduleEntry.positions;
        const assignLeadOrReplace = (key) => {
            if (!p[key]) {
                p[key] = spouse.name;
                this.recordVolunteerUsage(spouse.name, scheduleEntry.date);
                if (excludeSet) excludeSet.add(spouse.name);
                return true;
            }
            const replaced = p[key];
            if (replaced === spouse.name) return true;
            this.removeReplacedTeacherSpouse(replaced, scheduleEntry);
            this.removeVolunteerUsage(replaced, scheduleEntry.date);
            p[key] = spouse.name;
            this.recordVolunteerUsage(spouse.name, scheduleEntry.date);
            if (excludeSet) excludeSet.add(spouse.name);
            return true;
        };

        if (spouse.isToddlerLeadTeacher && assignLeadOrReplace('toddler2LeadTeacher')) return true;
        if ((spouse.isPreK1LeadTeacher || spouse.isPreKLeadTeacher) && assignLeadOrReplace('preK1LeadTeacher')) return true;
        if ((spouse.isPreK2LeadTeacher || spouse.isPreKLeadTeacher) && assignLeadOrReplace('preK2LeadTeacher')) return true;

        const tryGeneral = (key) => {
            if (!this.positionAllowedByPreference(spouse, key)) return false;
            if (key === 'checkInCoordinator') {
                if (!p.checkInCoordinator) {
                    p.checkInCoordinator = spouse.name;
                    this.recordVolunteerUsage(spouse.name, scheduleEntry.date);
                    if (excludeSet) excludeSet.add(spouse.name);
                    return true;
                }
                return false;
            }
            const cap = key === 'crawlers' ? 3 : 2;
            if (p[key].length < cap) {
                p[key].push(spouse.name);
                this.recordVolunteerUsage(spouse.name, scheduleEntry.date);
                if (excludeSet) excludeSet.add(spouse.name);
                return true;
            }
            return false;
        };

        return (
            tryGeneral('checkInCoordinator') ||
            tryGeneral('crawlers') ||
            tryGeneral('toddler1') ||
            tryGeneral('toddler2') ||
            tryGeneral('preK1') ||
            tryGeneral('preK2')
        );
    }

    generateSingleSchedule() {
        this.schedule = this.sundays.map((date) => ({
            date: new Date(date),
            skipStaffing: this.isSundaySkipped(date),
            positions: {
                checkInCoordinator: null,
                crawlers: [],
                toddler1: [],
                toddler2LeadTeacher: null,
                toddler2: [],
                preK1LeadTeacher: null,
                preK1: [],
                preK2LeadTeacher: null,
                preK2: []
            },
            futureScheduledPositions: {
                checkInCoordinator: false,
                crawlers: [],
                toddler1: [],
                toddler2LeadTeacher: false,
                toddler2: [],
                preK1LeadTeacher: false,
                preK1: [],
                preK2LeadTeacher: false,
                preK2: []
            },
            positionPreferencePositions: {
                checkInCoordinator: false,
                crawlers: [],
                toddler1: [],
                toddler2LeadTeacher: false,
                toddler2: [],
                preK1LeadTeacher: false,
                preK1: [],
                preK2LeadTeacher: false,
                preK2: []
            }
        }));

        this.volunteerUsage = {};
        this.violations = { threePlusUses: new Set(), insufficientGaps: {} };
        this.volunteers.forEach(v => {
            this.volunteerUsage[v.name] = { count: 0, dates: [], cycles: 0 };
        });

        const globalShuffle = this.shuffle(this.volunteers);

        this.setFutureScheduledDates();

        const toddler2Leads = this.volunteers.filter(v => v.isToddlerLeadTeacher);
        const preK1Leads = this.volunteers.filter(v => v.isPreK1LeadTeacher || v.isPreKLeadTeacher);
        const preK2Leads = this.volunteers.filter(v => v.isPreK2LeadTeacher || v.isPreKLeadTeacher);

        const toddler2Order = this.shuffle(toddler2Leads);
        const preK1Order = this.shuffle(preK1Leads);
        const preK2Order = this.shuffle(preK2Leads);
        const toddler2Cycle = { usedInCycle: new Set() };
        const preK1Cycle = { usedInCycle: new Set() };
        const preK2Cycle = { usedInCycle: new Set() };

        this.scheduleLeadTeachers(toddler2Order, preK1Order, preK2Order, toddler2Cycle, preK1Cycle, preK2Cycle);

        const fillOrder = globalShuffle.filter(
            (v) => !v.isToddlerLeadTeacher && !this.isAnyPreKLeadVolunteer(v)
        );
        const fillCycle = { usedInCycle: new Set() };
        this.fillRemainingPositions(fillOrder, fillCycle);
        this.rebalanceGeneralPoolNoSpouse();

        this.checkViolationsHighUsage();
        this.checkInsufficientGapViolations();
        return this.cloneScheduleData();
    }

    checkViolationsHighUsage() {
        this.violations.threePlusUses.clear();
        Object.entries(this.volunteerUsage).forEach(([name, usage]) => {
            if (usage.count >= 4) this.violations.threePlusUses.add(name);
        });
    }

    /**
     * Record all date-pair gaps that are <= base gap requirement.
     * Mirrors DEV behavior by skipping pair violations that involve future-scheduled dates.
     */
    checkInsufficientGapViolations() {
        this.violations.insufficientGaps = {};

        this.volunteers.forEach((volunteer) => {
            const usage = this.volunteerUsage[volunteer.name] || { dates: [] };
            const previouslyScheduledSet = new Set(
                (volunteer.previouslyScheduledDates || []).map((d) =>
                    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
                )
            );
            const ownDates = [
                ...(volunteer.previouslyScheduledDates || []),
                ...(usage.dates || [])
            ];

            const unique = [];
            const seen = new Set();
            ownDates.forEach((d) => {
                const t = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
                if (!seen.has(t)) {
                    seen.add(t);
                    unique.push(new Date(d.getFullYear(), d.getMonth(), d.getDate()));
                }
            });
            unique.sort((a, b) => a - b);

            const conflictingPairs = [];
            for (let i = 1; i < unique.length; i++) {
                const date1 = unique[i - 1];
                const date2 = unique[i];
                const gap = this.weeksBetween(date1, date2);
                if (gap <= this.minSchedulingGapWeeks) {
                    const date1IsFuture = (volunteer.futureScheduledDates || []).some((f) =>
                        this.isSameDate(f.date, date1)
                    );
                    const date2IsFuture = (volunteer.futureScheduledDates || []).some((f) =>
                        this.isSameDate(f.date, date2)
                    );
                    if (!date1IsFuture && !date2IsFuture) {
                        conflictingPairs.push({
                            date1,
                            date2,
                            gap,
                            date1IsPreviouslyScheduled: previouslyScheduledSet.has(date1.getTime()),
                            date2IsPreviouslyScheduled: previouslyScheduledSet.has(date2.getTime())
                        });
                    }
                }
            }

            if (conflictingPairs.length > 0) {
                this.violations.insufficientGaps[volunteer.name] = conflictingPairs;
            }
        });
    }

    hasInsufficientGapOnDate(name, date) {
        if (!name || !date) return false;
        const pairs = this.violations.insufficientGaps[name] || [];
        return pairs.some(
            (p) => this.isSameDate(p.date1, date) || this.isSameDate(p.date2, date)
        );
    }

    /** Word-boundary match for "toddler 1" / "toddler1" style tokens (avoids "toddler 10"). */
    futurePositionHasToddlerRoom(pos, roomNum) {
        const p = pos.toLowerCase();
        const re = new RegExp(`\\btoddler\\s*${roomNum}\\b`);
        return re.test(p) || p.includes(`toddler${roomNum}`);
    }

    futurePositionHasPreKRoom(pos, roomNum) {
        const p = pos.toLowerCase();
        const re = new RegExp(`\\bpre\\s*[-]?\\s*k\\s*${roomNum}\\b`, 'i');
        return re.test(p) || p.includes(`prek${roomNum}`) || p.includes(`pre-k${roomNum}`);
    }

    setFutureScheduledDates() {
        this.volunteers.forEach(volunteer => {
            volunteer.futureScheduledDates.forEach(future => {
                const scheduleEntry = this.schedule.find(s => this.isSameDate(s.date, future.date));
                if (!scheduleEntry) return;

                if (scheduleEntry.skipStaffing) {
                    return;
                }

                if (!this.canPlaceVolunteerOnDate(volunteer, scheduleEntry.date, { purpose: 'future' })) {
                    console.warn(
                        `Skipping future assignment for ${volunteer.name}: blockout on ${scheduleEntry.date.toLocaleDateString('en-US')}`
                    );
                    return;
                }

                const pos = future.position.toLowerCase().replace(/\s+/g, ' ').trim();
                const p = scheduleEntry.positions;
                const fp = scheduleEntry.futureScheduledPositions;
                let assigned = false;

                const isPreK = pos.includes('pre') && (pos.includes('k') || pos.includes('k-') || pos.includes('k '));

                if (pos.includes('check') || pos.includes('check-in')) {
                    if (!p.checkInCoordinator) {
                        p.checkInCoordinator = volunteer.name;
                        fp.checkInCoordinator = true;
                        assigned = true;
                    }
                } else if (pos.includes('crawler')) {
                    if (p.crawlers.length < 3) {
                        p.crawlers.push(volunteer.name);
                        fp.crawlers.push(volunteer.name);
                        assigned = true;
                    }
                } else if (pos.includes('toddler') && pos.includes('lead')) {
                    if (!p.toddler2LeadTeacher) {
                        p.toddler2LeadTeacher = volunteer.name;
                        fp.toddler2LeadTeacher = true;
                        assigned = true;
                    }
                } else if (this.futurePositionHasPreKRoom(pos, 2) && pos.includes('lead')) {
                    if (!p.preK2LeadTeacher) {
                        p.preK2LeadTeacher = volunteer.name;
                        fp.preK2LeadTeacher = true;
                        assigned = true;
                    }
                } else if (this.futurePositionHasPreKRoom(pos, 1) && pos.includes('lead')) {
                    if (!p.preK1LeadTeacher) {
                        p.preK1LeadTeacher = volunteer.name;
                        fp.preK1LeadTeacher = true;
                        assigned = true;
                    }
                } else if (isPreK && pos.includes('lead')) {
                    if (!p.preK1LeadTeacher) {
                        p.preK1LeadTeacher = volunteer.name;
                        fp.preK1LeadTeacher = true;
                        assigned = true;
                    } else if (!p.preK2LeadTeacher) {
                        p.preK2LeadTeacher = volunteer.name;
                        fp.preK2LeadTeacher = true;
                        assigned = true;
                    }
                } else if (pos.includes('toddler') && this.futurePositionHasToddlerRoom(pos, 1) && !pos.includes('lead')) {
                    if (p.toddler1.length < 2) {
                        p.toddler1.push(volunteer.name);
                        fp.toddler1.push(volunteer.name);
                        assigned = true;
                    }
                } else if (
                    pos.includes('toddler') &&
                    this.futurePositionHasToddlerRoom(pos, 2) &&
                    !pos.includes('lead')
                ) {
                    if (p.toddler2.length < 2) {
                        p.toddler2.push(volunteer.name);
                        fp.toddler2.push(volunteer.name);
                        assigned = true;
                    }
                } else if (pos.includes('toddler') && !pos.includes('lead')) {
                    if (p.toddler1.length < 2) {
                        p.toddler1.push(volunteer.name);
                        fp.toddler1.push(volunteer.name);
                        assigned = true;
                    } else if (p.toddler2.length < 2) {
                        p.toddler2.push(volunteer.name);
                        fp.toddler2.push(volunteer.name);
                        assigned = true;
                    }
                } else if (isPreK && this.futurePositionHasPreKRoom(pos, 2) && !pos.includes('lead')) {
                    if (p.preK2.length < 2) {
                        p.preK2.push(volunteer.name);
                        fp.preK2.push(volunteer.name);
                        assigned = true;
                    }
                } else if (isPreK && this.futurePositionHasPreKRoom(pos, 1) && !pos.includes('lead')) {
                    if (p.preK1.length < 2) {
                        p.preK1.push(volunteer.name);
                        fp.preK1.push(volunteer.name);
                        assigned = true;
                    }
                } else if (isPreK && !pos.includes('lead')) {
                    if (p.preK1.length < 2) {
                        p.preK1.push(volunteer.name);
                        fp.preK1.push(volunteer.name);
                        assigned = true;
                    } else if (p.preK2.length < 2) {
                        p.preK2.push(volunteer.name);
                        fp.preK2.push(volunteer.name);
                        assigned = true;
                    }
                }

                if (assigned) {
                    this.recordVolunteerUsage(volunteer.name, future.date);
                }
            });
        });
    }

    scheduleLeadTeachers(toddler2Order, preK1Order, preK2Order, toddler2Cycle, preK1Cycle, preK2Cycle) {
        const relaxedGapWeeks = Math.max(1, this.minSchedulingGapWeeks - 1);
        const cycleArgs = [toddler2Cycle, preK1Cycle, preK2Cycle];
        void cycleArgs;

        const orderIndexByName = {};
        [toddler2Order, preK1Order, preK2Order].forEach((order) => {
            order.forEach((vol, idx) => {
                if (!(vol.name in orderIndexByName)) orderIndexByName[vol.name] = idx;
            });
        });

        const preKPool = [];
        const seenPreK = new Set();
        [...preK1Order, ...preK2Order].forEach((vol) => {
            if (!seenPreK.has(vol.name)) {
                seenPreK.add(vol.name);
                preKPool.push(vol);
            }
        });

        const weeksRestBefore = (volunteer, date) => {
            let last = null;
            const consider = (d) => {
                if (!d) return;
                const n = new Date(d.getFullYear(), d.getMonth(), d.getDate());
                const c = new Date(date.getFullYear(), date.getMonth(), date.getDate());
                if (n.getTime() >= c.getTime()) return;
                if (!last || n > last) last = n;
            };
            (volunteer.previouslyScheduledDates || []).forEach(consider);
            (volunteer.futureScheduledDates || []).forEach((f) => consider(f.date));
            (this.volunteerUsage[volunteer.name]?.dates || []).forEach(consider);
            if (!last) return Number.POSITIVE_INFINITY;
            return this.weeksBetween(last, date);
        };

        const spouseGapForRest = (restWeeks) => {
            if (!Number.isFinite(restWeeks) || restWeeks > this.minSchedulingGapWeeks) {
                return this.minSchedulingGapWeeks;
            }
            if (restWeeks > relaxedGapWeeks) return relaxedGapWeeks;
            return 0;
        };

        const restTier = (restWeeks) => {
            if (!Number.isFinite(restWeeks) || restWeeks > this.minSchedulingGapWeeks) return 0;
            if (restWeeks > relaxedGapWeeks) return 1;
            return 2;
        };

        const rankPool = (pool, entry) => {
            return pool
                .filter((vol) =>
                    !this.isVolunteerNameOnEntry(vol.name, entry) &&
                    !this.isExplicitBlockout(vol, entry.date)
                )
                .map((vol) => {
                    const restWeeks = weeksRestBefore(vol, entry.date);
                    const usage = this.volunteerUsage[vol.name] || { count: 0 };
                    return {
                        volunteer: vol,
                        restWeeks,
                        usageCount: usage.count,
                        minGapWeeks: spouseGapForRest(restWeeks),
                        orderIdx: Number.isFinite(orderIndexByName[vol.name])
                            ? orderIndexByName[vol.name]
                            : Number.MAX_SAFE_INTEGER
                    };
                })
                .sort((a, b) => {
                    const tierA = restTier(a.restWeeks);
                    const tierB = restTier(b.restWeeks);
                    if (tierA !== tierB) return tierA - tierB;
                    const restA = Number.isFinite(a.restWeeks) ? a.restWeeks : Number.MAX_SAFE_INTEGER;
                    const restB = Number.isFinite(b.restWeeks) ? b.restWeeks : Number.MAX_SAFE_INTEGER;
                    if (restA !== restB) return restB - restA;
                    if (a.usageCount !== b.usageCount) return a.usageCount - b.usageCount;
                    return a.orderIdx - b.orderIdx;
                });
        };

        const applyOption = (slot, option) => {
            const entry = this.schedule[slot.entryIndex];
            if (!entry || entry.positions[slot.key]) return false;
            const pick = option.volunteer;
            if (this.isVolunteerNameOnEntry(pick.name, entry)) return false;
            if (this.isExplicitBlockout(pick, entry.date)) return false;
            const spouseGap = Number.isFinite(option.minGapWeeks) ? option.minGapWeeks : 0;
            if (pick.spouse && !this.canSpouseBeScheduledOnDate(pick.spouse, entry, null, slot.key, spouseGap)) {
                if (spouseGap > 0 && !this.canSpouseBeScheduledOnDate(pick.spouse, entry, null, slot.key, 0)) {
                    return false;
                }
                if (spouseGap === 0) return false;
            }
            entry.positions[slot.key] = pick.name;
            this.recordVolunteerUsage(pick.name, entry.date);
            if (pick.spouse) {
                const placed =
                    this.scheduleSpouseOnSameDateStrict(pick.spouse, entry, null, slot.key, spouseGap) ||
                    (spouseGap > 0 &&
                        this.scheduleSpouseOnSameDateStrict(pick.spouse, entry, null, slot.key, 0));
                if (!placed) {
                    this.removeVolunteerUsage(pick.name, entry.date);
                    entry.positions[slot.key] = null;
                    return false;
                }
            }
            return true;
        };

        const fillSlotFromOptions = (entryIndex, key, options) => {
            const slot = { entryIndex, key };
            for (const option of options) {
                if (applyOption(slot, option)) return;
            }
        };

        this.schedule.forEach((entry, entryIndex) => {
            if (entry.skipStaffing) return;

            if (!entry.positions.toddler2LeadTeacher) {
                fillSlotFromOptions(entryIndex, 'toddler2LeadTeacher', rankPool(toddler2Order, entry));
            }

            const preKKeys = [];
            if (!entry.positions.preK1LeadTeacher) preKKeys.push('preK1LeadTeacher');
            if (!entry.positions.preK2LeadTeacher) preKKeys.push('preK2LeadTeacher');
            if (preKKeys.length === 0) return;

            const preKOptions = rankPool(preKPool, entry);
            preKKeys.forEach((key) => {
                fillSlotFromOptions(entryIndex, key, preKOptions);
            });
        });
    }

    /**
     * Per Sunday: Check-In → Crawler×3 → Toddler 1×2 → Toddler 2×2 → Pre-K 1×2 → Pre-K 2×2.
     * Includes strict spouse same-week co-scheduling and preference-aware candidate weighting.
     */
    fillRemainingPositions(fillOrder, fillCycle) {
        let spousePlaceFailed = new Set();

        const remainingGeneralCapacity = (entry) => {
            const p = entry.positions;
            let open = 0;
            if (!p.checkInCoordinator) open += 1;
            open += Math.max(0, 3 - (p.crawlers || []).length);
            open += Math.max(0, 2 - (p.toddler1 || []).length);
            open += Math.max(0, 2 - (p.toddler2 || []).length);
            open += Math.max(0, 2 - (p.preK1 || []).length);
            open += Math.max(0, 2 - (p.preK2 || []).length);
            return open;
        };

        const canFillGeneral = (vol, scheduleEntry, positionKey, scheduled) => {
            if (!vol) return false;
            if (scheduled.has(vol.name)) return false;
            if (spousePlaceFailed.has(vol.name)) return false;
            if (!this.positionAllowedByPreference(vol, positionKey)) return false;
            if (!this.canPlaceVolunteerOnDate(vol, scheduleEntry.date, { purpose: 'algorithm' })) return false;
            if (vol.spouse) {
                if (!this.canSpouseBeScheduledOnDate(vol.spouse, scheduleEntry, scheduled, positionKey)) return false;
            }
            return true;
        };

        const preferenceWeight = (vol) => {
            const pref = vol.normalizedPreferences || new Set();
            if (pref.size === 0 || vol.isGeneralPreferenceWildcard) return 100;
            return pref.size; // fewer preferences => stronger priority
        };

        const pickGeneral = (pool, startIndex, scheduleEntry, positionKey, scheduled, softCap = null) => {
            const remaining = remainingGeneralCapacity(scheduleEntry);
            const candidates = [];
            for (let i = 0; i < pool.length; i++) {
                const vol = pool[i];
                if (!canFillGeneral(vol, scheduleEntry, positionKey, scheduled)) continue;
                const usage = this.volunteerUsage[vol.name] || { count: 0, cycles: 0 };
                if (Number.isFinite(softCap) && usage.count >= softCap) continue;
                const distance = i >= startIndex ? i - startIndex : (pool.length - startIndex) + i;
                const isCouple = !!vol.spouse;
                const couplePrefer = remaining >= 2 ? (isCouple ? 0 : 1) : (isCouple ? 1 : 0);
                candidates.push({
                    vol,
                    index: i,
                    usageCount: usage.count,
                    cycles: usage.cycles,
                    prefWeight: preferenceWeight(vol),
                    neverUsed: usage.count === 0 ? 0 : 1,
                    couplePrefer,
                    spouseUsage: vol.spouse && this.volunteerUsage[vol.spouse]
                        ? this.volunteerUsage[vol.spouse].count
                        : 0,
                    distance
                });
            }
            if (candidates.length === 0) return null;
            candidates.sort((a, b) => {
                if (a.usageCount !== b.usageCount) return a.usageCount - b.usageCount;
                if (a.neverUsed !== b.neverUsed) return a.neverUsed - b.neverUsed;
                if (a.couplePrefer !== b.couplePrefer) return a.couplePrefer - b.couplePrefer;
                if (a.spouseUsage !== b.spouseUsage) return a.spouseUsage - b.spouseUsage;
                if (a.prefWeight !== b.prefWeight) return a.prefWeight - b.prefWeight;
                if (a.cycles !== b.cycles) return a.cycles - b.cycles;
                return a.distance - b.distance;
            });
            return candidates[0];
        };

        let generalIndex = 0;
        this.schedule.forEach((scheduleEntry) => {
            if (scheduleEntry.skipStaffing) return;

            const scheduled = new Set();
            spousePlaceFailed = new Set();

            const collect = () => {
                scheduled.clear();
                const p = scheduleEntry.positions;
                if (p.checkInCoordinator) scheduled.add(p.checkInCoordinator);
                p.crawlers.forEach(n => scheduled.add(n));
                p.toddler1.forEach(n => scheduled.add(n));
                p.toddler2.forEach(n => scheduled.add(n));
                p.preK1.forEach(n => scheduled.add(n));
                p.preK2.forEach(n => scheduled.add(n));
                if (p.toddler2LeadTeacher) scheduled.add(p.toddler2LeadTeacher);
                if (p.preK1LeadTeacher) scheduled.add(p.preK1LeadTeacher);
                if (p.preK2LeadTeacher) scheduled.add(p.preK2LeadTeacher);
            };

            collect();

            const tryFill = (positionKey) => {
                let pick = pickGeneral(fillOrder, generalIndex, scheduleEntry, positionKey, scheduled, 3);
                if (!pick) pick = pickGeneral(fillOrder, generalIndex, scheduleEntry, positionKey, scheduled, null);
                if (!pick) return null;
                generalIndex = (pick.index + 1) % fillOrder.length;
                if (generalIndex === 0) {
                    fillOrder.forEach((v) => {
                        this.volunteerUsage[v.name].cycles++;
                    });
                }
                return pick.vol;
            };

            const unassignGeneral = (positionKey, name) => {
                const p = scheduleEntry.positions;
                if (positionKey === 'checkInCoordinator') {
                    if (p.checkInCoordinator === name) p.checkInCoordinator = null;
                } else {
                    const idx = p[positionKey].indexOf(name);
                    if (idx !== -1) p[positionKey].splice(idx, 1);
                }
                this.removeVolunteerUsage(name, scheduleEntry.date);
                scheduled.delete(name);
            };

            const assignWithSpouse = (v, positionKey) => {
                const p = scheduleEntry.positions;
                if (positionKey === 'checkInCoordinator') {
                    p.checkInCoordinator = v.name;
                } else {
                    p[positionKey].push(v.name);
                }
                this.recordVolunteerUsage(v.name, scheduleEntry.date);
                scheduled.add(v.name);

                if (!v.spouse) return true;
                const spousePlaced = this.scheduleSpouseOnSameDateStrict(
                    v.spouse,
                    scheduleEntry,
                    scheduled,
                    positionKey
                );
                if (spousePlaced) return true;

                unassignGeneral(positionKey, v.name);
                spousePlaceFailed.add(v.name);
                spousePlaceFailed.add(v.spouse);
                return false;
            };

            if (!scheduleEntry.positions.checkInCoordinator) {
                let attempts = 0;
                while (!scheduleEntry.positions.checkInCoordinator && attempts < fillOrder.length) {
                    attempts++;
                    const v = tryFill('checkInCoordinator');
                    if (!v) break;
                    assignWithSpouse(v, 'checkInCoordinator');
                }
            }

            while (scheduleEntry.positions.crawlers.length < 3) {
                const v = tryFill('crawlers');
                if (!v) break;
                if (!assignWithSpouse(v, 'crawlers')) continue;
            }

            while (scheduleEntry.positions.toddler1.length < 2) {
                const v = tryFill('toddler1');
                if (!v) break;
                if (!assignWithSpouse(v, 'toddler1')) continue;
            }

            while (scheduleEntry.positions.toddler2.length < 2) {
                const v = tryFill('toddler2');
                if (!v) break;
                if (!assignWithSpouse(v, 'toddler2')) continue;
            }

            while (scheduleEntry.positions.preK1.length < 2) {
                const v = tryFill('preK1');
                if (!v) break;
                if (!assignWithSpouse(v, 'preK1')) continue;
            }

            while (scheduleEntry.positions.preK2.length < 2) {
                const v = tryFill('preK2');
                if (!v) break;
                if (!assignWithSpouse(v, 'preK2')) continue;
            }
        });
    }

    rebalanceGeneralPoolNoSpouse(maxIterations = 150) {
        const generalKeys = ['checkInCoordinator', 'crawlers', 'toddler1', 'toddler2', 'preK1', 'preK2'];
        const getVolunteer = (name) => this.volunteers.find((v) => v.name === name);
        const isLeadVolunteer = (vol) =>
            !!vol && (vol.isToddlerLeadTeacher || this.isAnyPreKLeadVolunteer(vol));
        const isEligibleRecipient = (vol, scheduleEntry, positionKey) => {
            if (!vol || vol.spouse) return false;
            if (isLeadVolunteer(vol)) return false;
            if (this.infeasibleVolunteers[vol.name]) return false;
            if (this.isVolunteerNameOnEntry(vol.name, scheduleEntry)) return false;
            if (!this.positionAllowedByPreference(vol, positionKey)) return false;
            if (!this.canPlaceVolunteerOnDate(vol, scheduleEntry.date, { purpose: 'algorithm' })) return false;
            return true;
        };

        let improved = true;
        let iterations = 0;
        while (improved && iterations < maxIterations) {
            improved = false;
            iterations++;

            const usageEntries = Object.entries(this.volunteerUsage)
                .filter(([name, usage]) => {
                    const v = getVolunteer(name);
                    return v && !v.spouse && !isLeadVolunteer(v) && !this.infeasibleVolunteers[name] && usage.count > 0;
                })
                .sort((a, b) => b[1].count - a[1].count);

            const lowUsageEntries = Object.entries(this.volunteerUsage)
                .filter(([name]) => {
                    const v = getVolunteer(name);
                    return v && !v.spouse && !isLeadVolunteer(v) && !this.infeasibleVolunteers[name];
                })
                .sort((a, b) => a[1].count - b[1].count);

            for (const [donorName, donorUsage] of usageEntries) {
                if (donorUsage.count <= 1) continue;

                let swapped = false;
                for (let i = 0; i < this.schedule.length && !swapped; i++) {
                    const entry = this.schedule[i];
                    if (entry.skipStaffing) continue;
                    const p = entry.positions;

                    for (const key of generalKeys) {
                        const positions =
                            key === 'checkInCoordinator'
                                ? (p.checkInCoordinator ? [{ type: 'single', key }] : [])
                                : (p[key] || []).map((_, idx) => ({ type: 'list', key, idx }));

                        for (const pos of positions) {
                            const assignedName =
                                pos.type === 'single' ? p[pos.key] : p[pos.key][pos.idx];
                            if (assignedName !== donorName) continue;

                            for (const [recipientName, recipientUsage] of lowUsageEntries) {
                                if (recipientName === donorName) continue;
                                if (recipientUsage.count >= donorUsage.count - 1) continue;
                                const recipientVol = getVolunteer(recipientName);
                                if (!isEligibleRecipient(recipientVol, entry, key)) continue;

                                if (pos.type === 'single') {
                                    p[pos.key] = recipientName;
                                } else {
                                    p[pos.key][pos.idx] = recipientName;
                                }
                                this.removeVolunteerUsage(donorName, entry.date);
                                this.recordVolunteerUsage(recipientName, entry.date);
                                improved = true;
                                swapped = true;
                                break;
                            }
                            if (swapped) break;
                        }
                        if (swapped) break;
                    }
                }
                if (improved) break;
            }
        }
    }

    generateSchedule() {
        const generateBtn = document.getElementById('generateBtn');
        const loadingSpinner = document.getElementById('loadingSpinner');

        if (this.volunteers.length === 0) {
            alert('Please upload a volunteer list file first.');
            return;
        }

        generateBtn.disabled = true;
        loadingSpinner.classList.remove('hidden');

        setTimeout(() => {
            try {
                const quarter = document.getElementById('quarter').value;
                const year = parseInt(document.getElementById('year').value);
                const { startDate, endDate } = this.getQuarterDates(quarter, year);
                this.quarterStartDate = startDate;
                this.quarterEndDate = endDate;
                this.sundays = this.getSundaysInQuarter(startDate, endDate);

                this.minSchedulingGapWeeks = 3;

                this.volunteers.forEach(v => {
                    v.blockoutDates = v.blockoutDates.filter(
                        d => this.isDateInQuarter(d, startDate, endDate) && this.isSunday(d)
                    );
                    v.futureScheduledDates = v.futureScheduledDates.filter(
                        f => this.isDateInQuarter(f.date, startDate, endDate) && this.isSunday(f.date)
                    );
                    v.previouslyScheduledDates = v.previouslyScheduledDates.filter(d => this.isSunday(d));
                    this.enrichVolunteerPreferences(v);
                });

                this.skipSundayDateKeys = this.getSkipSundayKeysFromDOM();
                this.futureOnSkippedWarnings = this.buildFutureOnSkippedWarnings();

                this.assessVolunteerFeasibility();
                this.generateMultipleSchedules(10);
                this.displaySchedule();
                this.displayStatistics();
                document.getElementById('scheduleSection').classList.remove('hidden');
                document.getElementById('statisticsSection').classList.remove('hidden');
            } catch (error) {
                alert(`Error generating schedule: ${error.message}`);
                console.error(error);
            } finally {
                generateBtn.disabled = false;
                loadingSpinner.classList.add('hidden');
            }
        }, 100);
    }

    displaySchedule() {
        const output = document.getElementById('scheduleOutput');
        const scheduleTitle = document.querySelector('#scheduleSection h2');
        if (scheduleTitle) {
            const best = this.lastGenerationResult?.bestScore;
            if (best) {
                scheduleTitle.textContent = `Generated Schedule (Best Score: ${best.total.toFixed(1)}%)`;
            } else {
                scheduleTitle.textContent = 'Generated Schedule';
            }
        }

        const visualClass = this.highlightsEnabled ? '' : ' schedule-highlights-off';
        let html = `<div class="schedule-visual${visualClass}">`;
        if (this.futureOnSkippedWarnings && this.futureOnSkippedWarnings.length > 0) {
            html += '<div class="skip-weeks-warnings"><h3>Future file vs no-volunteer Sundays</h3><ul>';
            this.futureOnSkippedWarnings.forEach((w) => {
                html += `<li>${this.escapeHtml(w)}</li>`;
            });
            html += '</ul></div>';
        }
        html += '<div class="schedule-table-container">';
        html += '<table class="schedule-table schedule-table--wide">';
        html += '<thead><tr>';
        html += '<th scope="col">Date</th>';
        html += '<th scope="col">Check-In Coordinator</th>';
        html += '<th scope="col">Crawler</th>';
        html += '<th scope="col">Toddler 1</th>';
        html += '<th scope="col">Toddler 2 Lead</th>';
        html += '<th scope="col">Toddler 2</th>';
        html += '<th scope="col">Pre-K 1 Lead</th>';
        html += '<th scope="col">Pre-K 1</th>';
        html += '<th scope="col">Pre-K 2 Lead</th>';
        html += '<th scope="col">Pre-K 2</th>';
        html += '</tr></thead><tbody>';

        this.schedule.forEach((entry) => {
            const dateStr = entry.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            const fp = entry.futureScheduledPositions;
            const p = entry.positions;
            const skip = !!entry.skipStaffing;
            const rowAttr = skip ? ' class="schedule-row--skipped"' : '';
            html += `<tr${rowAttr}>`;
            const dateCellClass = skip ? 'date-cell date-cell--skipped' : 'date-cell';
            const dateInner = skip
                ? `${dateStr}<span class="date-cell-sublabel">No volunteers</span>`
                : dateStr;
            html += `<td class="${dateCellClass}">${dateInner}</td>`;

            const checkInName = p.checkInCoordinator;
            const c1 = this.formatVolunteerName(checkInName, fp.checkInCoordinator, false, entry.date);
            html += `<td class="${c1.cellClass}">${c1.name}</td>`;

            html += this.formatStackedVolunteerCell(p.crawlers, fp.crawlers, entry.date);

            html += this.formatStackedVolunteerCell(p.toddler1, fp.toddler1, entry.date);

            const t2l = this.formatVolunteerName(p.toddler2LeadTeacher, fp.toddler2LeadTeacher, false, entry.date);
            html += `<td class="${t2l.cellClass}">${t2l.name}</td>`;

            html += this.formatStackedVolunteerCell(p.toddler2, fp.toddler2, entry.date);

            const pk1l = this.formatVolunteerName(p.preK1LeadTeacher, fp.preK1LeadTeacher, false, entry.date);
            html += `<td class="${pk1l.cellClass}">${pk1l.name}</td>`;

            html += this.formatStackedVolunteerCell(p.preK1, fp.preK1, entry.date);

            const pk2l = this.formatVolunteerName(p.preK2LeadTeacher, fp.preK2LeadTeacher, false, entry.date);
            html += `<td class="${pk2l.cellClass}">${pk2l.name}</td>`;

            html += this.formatStackedVolunteerCell(p.preK2, fp.preK2, entry.date);
            html += '</tr>';
        });

        html += '</tbody></table></div>';
        if (this.lastGenerationResult) {
            html += '<div class="generation-score-card">';
            html += `<h3>Generation Results</h3>`;
            html += `<p><strong>Attempts:</strong> ${this.lastGenerationResult.attemptCount}</p>`;
            html += `<p><strong>Best attempt:</strong> #${this.lastGenerationResult.bestIndex + 1} (${this.lastGenerationResult.bestScore.total.toFixed(1)}%)</p>`;
            html += '<ul class="top-attempts-list">';
            this.lastGenerationResult.topRuns.forEach((run, idx) => {
                html += `<li>#${idx + 1}: attempt ${run.index + 1} - ${run.score.total.toFixed(1)}% (viol ${run.score.violationScore.toFixed(1)}, fair ${run.score.fairnessScore.toFixed(1)}, pref ${run.score.preferenceScore.toFixed(1)}, gap ${run.score.gapQualityScore.toFixed(1)}, blanks ${run.score.blankCount || 0})</li>`;
            });
            html += '</ul>';
            html += '</div>';
        }
        html += '<div class="legend-violations-container">';
        html += '<div class="schedule-legend">';
        html += '<p class="legend-title"><strong>Legend:</strong></p>';
        html += `<label class="legend-toggle"><input type="checkbox" id="toggleHighlights" ${this.highlightsEnabled ? 'checked' : ''}> Show highlights</label>`;
        html += '<ul class="legend-list">';
        html += '<li><span class="future-scheduled">Underlined names</span> = preset future date from file</li>';
        html += `<li><span class="highlight-yellow">Yellow</span> = gap less than ${this.minSchedulingGapWeeks + 1} weeks</li>`;
        html += '<li><span class="highlight-purple">Purple</span> = 4+ assignments (FYI only)</li>';
        html += '<li><span class="legend-skipped-sample">Grey row</span> = no volunteers that Sunday (still counts toward calendar gaps)</li>';
        html += '</ul></div>';
        html += '<div id="violationsContainer"></div>';
        html += '</div>';
        output.innerHTML = html;
        this.displayViolations();
    }

    /**
     * Renders one <td> with multiple names separated by horizontal rules (multi-slot roles).
     * @param {string[]} names - ordered slot values
     * @param {string[]} fromFutureList - names set via future file (for underline)
     */
    formatStackedVolunteerCell(names, fromFutureList, date) {
        const futureSet = new Set(fromFutureList || []);
        const list = Array.isArray(names) ? names.filter(n => n != null && String(n).trim() !== '') : [];
        if (list.length === 0) {
            const empty = this.formatVolunteerName(null, false, false, date);
            return `<td class="schedule-cell-stacked ${empty.cellClass}">${empty.name}</td>`;
        }
        const chunks = [];
        list.forEach((n, idx) => {
            if (idx > 0) {
                chunks.push('<hr class="schedule-cell-divider" />');
            }
            const fmt = this.formatVolunteerName(n, futureSet.has(n), false, date);
            chunks.push(`<div class="schedule-stack-row ${fmt.cellClass}">${fmt.name}</div>`);
        });
        return `<td class="schedule-cell-stacked">${chunks.join('')}</td>`;
    }

    formatVolunteerName(name, isFutureScheduled = false, isPositionPreference = false, date = null) {
        if (!name) return { name: '-', cellClass: '' };
        const hasThreePlusUses = this.violations.threePlusUses.has(name);
        const hasInsufficientGap = Object.prototype.hasOwnProperty.call(
            this.violations.insufficientGaps,
            name
        );
        let formattedName = name;
        let cellClass = '';
        if (this.highlightsEnabled) {
            if (hasThreePlusUses && hasInsufficientGap) cellClass = 'cell-highlight-red';
            else if (hasInsufficientGap) cellClass = 'cell-highlight-yellow';
            else if (hasThreePlusUses) cellClass = 'cell-highlight-purple';
        }
        if (this.highlightsEnabled && (isFutureScheduled || isPositionPreference)) {
            formattedName = `<span class="future-scheduled">${formattedName}</span>`;
        }
        return { name: formattedName, cellClass };
    }

    displayViolations() {
        const containerOutput = document.getElementById('violationsContainer');
        if (!containerOutput) return;

        const hasAny =
            this.violations.threePlusUses.size > 0 ||
            Object.keys(this.violations.insufficientGaps).length > 0;

        let html = '';
        if (!hasAny) {
            html = '<p class="success">✅ No violations detected.</p>';
            containerOutput.innerHTML = html;
            return;
        }

        if (Object.keys(this.violations.insufficientGaps).length > 0) {
            html += '<h3>Gap Violations</h3>';
            html += '<ul class="violations-list">';
            const signatureForPairs = (pairs) =>
                (pairs || [])
                    .map((pair) => {
                        const d1 = pair.date1.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                        const d2 = pair.date2.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                        return `${d1}|${d2}|${pair.gap}`;
                    })
                    .join('||');
            const renderDetails = (pairs) =>
                (pairs || [])
                    .map((pair) => {
                        const d1 = pair.date1.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                        const d2 = pair.date2.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                        return `<span class="violation-details">${d1} ↔ ${d2} (${pair.gap} week${pair.gap !== 1 ? 's' : ''})</span>`;
                    })
                    .join(', ');

            const entries = Object.entries(this.violations.insufficientGaps);
            const pairSignatureByName = {};
            entries.forEach(([name, pairs]) => {
                pairSignatureByName[name] = signatureForPairs(pairs);
            });

            const processed = new Set();
            entries.forEach(([name, pairs]) => {
                if (processed.has(name)) return;

                const volunteer = this.volunteers.find((v) => v.name === name);
                const spouseName = volunteer && volunteer.spouse ? volunteer.spouse : null;
                const canMergeWithSpouse =
                    spouseName &&
                    Object.prototype.hasOwnProperty.call(this.violations.insufficientGaps, spouseName) &&
                    pairSignatureByName[name] === pairSignatureByName[spouseName];

                const label = canMergeWithSpouse ? `${name} & ${spouseName}` : name;
                const hasThreePlusUses =
                    this.violations.threePlusUses.has(name) ||
                    (canMergeWithSpouse && this.violations.threePlusUses.has(spouseName));
                const cls = hasThreePlusUses ? 'highlight-red' : 'highlight-yellow';
                const details = renderDetails(pairs);
                html += `<li><span class="${cls}">${label}</span> ${details}</li>`;

                processed.add(name);
                if (canMergeWithSpouse) processed.add(spouseName);
            });
            html += '</ul>';
        }

        containerOutput.innerHTML = html;
    }

    displayStatistics() {
        const output = document.getElementById('statisticsOutput');
        const totalSundays = this.sundays.length;
        const skipCount = (this.schedule || []).filter((e) => e.skipStaffing).length;
        const staffedSundays = Math.max(0, totalSundays - skipCount);
        const volunteerPoolSize = this.volunteers.length;
        const infeasibleCount = Object.keys(this.infeasibleVolunteers || {}).length;
        const feasiblePoolSize = Math.max(0, volunteerPoolSize - infeasibleCount);
        const volunteersUsed = Object.entries(this.volunteerUsage).filter(
            ([name, u]) => !this.infeasibleVolunteers[name] && u.count > 0
        ).length;
        const avgUses =
            volunteersUsed > 0
                ? (
                      Object.entries(this.volunteerUsage)
                          .filter(([name]) => !this.infeasibleVolunteers[name])
                          .reduce((sum, [, u]) => sum + u.count, 0) /
                      volunteersUsed
                  ).toFixed(1)
                : 0;

        let html = '<div class="stats-grid">';
        html += `<div class="stat-card"><div class="stat-value">${totalSundays}</div><div class="stat-label">Sundays in quarter</div></div>`;
        html += `<div class="stat-card"><div class="stat-value">${staffedSundays}</div><div class="stat-label">Sundays staffed</div></div>`;
        html += `<div class="stat-card"><div class="stat-value">${volunteerPoolSize}</div><div class="stat-label">Volunteer Pool</div></div>`;
        html += `<div class="stat-card"><div class="stat-value">${feasiblePoolSize}</div><div class="stat-label">Usable Pool</div></div>`;
        html += `<div class="stat-card"><div class="stat-value">${volunteersUsed}</div><div class="stat-label">Usable Volunteers Used</div></div>`;
        html += `<div class="stat-card"><div class="stat-value">${avgUses}</div><div class="stat-label">Avg Uses/Volunteer</div></div>`;
        html += '</div>';
        if (infeasibleCount > 0) {
            html += `<p class="infeasible-summary-note">Excluded from unused penalties: ${infeasibleCount} volunteer(s) with no usable dates.</p>`;
        }

        html += '<h3>Volunteer Usage Summary</h3>';
        const preK1Leads = [];
        const preK2Leads = [];
        const toddler2Leads = [];
        const generalVolunteers = [];

        Object.entries(this.volunteerUsage).forEach(([name, usage]) => {
            const volunteer = this.volunteers.find(v => v.name === name);
            if (!volunteer) return;
            if (volunteer.isPreK1LeadTeacher || volunteer.isPreKLeadTeacher) preK1Leads.push([name, usage]);
            if (volunteer.isPreK2LeadTeacher || volunteer.isPreKLeadTeacher) preK2Leads.push([name, usage]);
            if (volunteer.isToddlerLeadTeacher) toddler2Leads.push([name, usage]);
            if (
                !volunteer.isToddlerLeadTeacher &&
                !this.isAnyPreKLeadVolunteer(volunteer)
            ) {
                generalVolunteers.push([name, usage]);
            }
        });

        const sortByUsage = (a, b) => b[1].count - a[1].count;

        preK1Leads.sort(sortByUsage);
        preK2Leads.sort(sortByUsage);
        toddler2Leads.sort(sortByUsage);
        generalVolunteers.sort(sortByUsage);

        const renderTable = (volunteers) => {
            let tableHtml = '<div class="volunteer-stats-table-container"><table class="volunteer-stats-table">';
            tableHtml += '<thead><tr><th>Volunteer Name</th><th>Times Used</th><th>Dates</th></tr></thead><tbody>';
            volunteers.forEach(([name, usage]) => {
                const datesStr = usage.dates
                    .map(d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }))
                    .join(', ');
                const nameDisplay = this.formatVolunteerName(name).name;
                const infeasible = this.infeasibleVolunteers[name];
                const shouldMarkUnusable = !!infeasible && usage.count === 0;
                const rowClass = shouldMarkUnusable ? ' class="volunteer-unusable-row"' : '';
                const note = shouldMarkUnusable ? `<div class="volunteer-unusable-note">${infeasible.reason}</div>` : '';
                tableHtml += `<tr${rowClass}>`;
                tableHtml += `<td>${nameDisplay}${note}</td>`;
                tableHtml += `<td>${usage.count}</td>`;
                tableHtml += `<td>${datesStr}</td>`;
                tableHtml += '</tr>';
            });
            tableHtml += '</tbody></table></div>';
            return tableHtml;
        };

        const renderCategory = (title, volunteers) => {
            if (volunteers.length === 0) return '';
            const mid = Math.ceil(volunteers.length / 2);
            return (
                `<div class="volunteer-stats-category-wrapper"><h4 class="volunteer-stats-category-heading">${title}</h4>` +
                `<div class="volunteer-stats-two-column">${renderTable(volunteers.slice(0, mid))}${renderTable(
                    volunteers.slice(mid)
                )}</div></div>`
            );
        };

        html += renderCategory('Pre-K 1 Lead Teachers', preK1Leads);
        html += renderCategory('Pre-K 2 Lead Teachers', preK2Leads);
        html += renderCategory('Toddler 2 Lead Teachers', toddler2Leads);
        html += renderCategory('General Volunteer Pool', generalVolunteers);
        output.innerHTML = html;
    }

    exportToCSV() {
        const escapeCSV = (value) => {
            if (!value) return '';
            if (value.includes(',') || value.includes('"') || value.includes('\n')) {
                return `"${value.replace(/"/g, '""')}"`;
            }
            return value;
        };

        const positionNames = [
            'Check-In Coordinator',
            'Crawler',
            'Crawler',
            'Crawler',
            'Toddler 1',
            'Toddler 1',
            'Toddler 2 Lead',
            'Toddler 2',
            'Toddler 2',
            'Pre-K 1 Lead',
            'Pre-K 1',
            'Pre-K 1',
            'Pre-K 2 Lead',
            'Pre-K 2',
            'Pre-K 2'
        ];

        const headerRow = ['Position'];
        this.schedule.forEach(entry => {
            headerRow.push(
                escapeCSV(
                    entry.date.toLocaleDateString('en-US', {
                        month: 'short',
                        day: 'numeric'
                    })
                )
            );
        });
        let csv = headerRow.join(',') + '\n';

        positionNames.forEach((positionName, index) => {
            const row = [escapeCSV(positionName)];
            this.schedule.forEach(entry => {
                const p = entry.positions;
                let volunteer = '';
                if (index === 0) volunteer = p.checkInCoordinator || '';
                else if (index >= 1 && index <= 3) volunteer = p.crawlers[index - 1] || '';
                else if (index >= 4 && index <= 5) volunteer = p.toddler1[index - 4] || '';
                else if (index === 6) volunteer = p.toddler2LeadTeacher || '';
                else if (index >= 7 && index <= 8) volunteer = p.toddler2[index - 7] || '';
                else if (index === 9) volunteer = p.preK1LeadTeacher || '';
                else if (index >= 10 && index <= 11) volunteer = p.preK1[index - 10] || '';
                else if (index === 12) volunteer = p.preK2LeadTeacher || '';
                else if (index >= 13 && index <= 14) volunteer = p.preK2[index - 13] || '';
                row.push(escapeCSV(volunteer));
            });
            csv += row.join(',') + '\n';
        });

        this.downloadFile(csv, 'quarterly-schedule.csv', 'text/csv');
    }

    exportToJSON() {
        const exportData = {
            generatedDate: new Date().toISOString(),
            quarter: document.getElementById('quarter').value,
            year: parseInt(document.getElementById('year').value),
            minSchedulingGapWeeks: this.minSchedulingGapWeeks,
            schedule: this.schedule.map((entry) => ({
                date: entry.date.toISOString(),
                skipStaffing: !!entry.skipStaffing,
                positions: entry.positions
            })),
            note:
                'Blockouts: exact Sunday only. Min gap: no algorithmic assignment within minSchedulingGapWeeks of previous/future-file/usage anchors; future file rows ignore gap but not blockout. skipStaffing: no volunteers that Sunday; row kept for calendar context; gaps still use real weeks between assignment dates.'
        };
        this.downloadFile(JSON.stringify(exportData, null, 2), 'quarterly-schedule.json', 'application/json');
    }

    downloadFile(content, filename, contentType) {
        const blob = new Blob([content], { type: contentType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    new QuarterlyScheduler();
});
