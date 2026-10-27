// Self-contained: Chrome serializes this function into the chosen Zhixue page.
// No cookies API, profile access, remote code, storage access, or score writes.
export async function zhixueProbe(command) {
  const progressKey = typeof command.runId === "string" && /^[a-z0-9-]{8,80}$/.test(command.runId)
    ? "__zhixue_probe_progress_" + command.runId : null;
  if (command.action === "progress") {
    if (location.origin !== "https://www.zhixue.com" || !progressKey) return null;
    const progress = globalThis[progressKey];
    return progress ? {total: progress.total, processed: progress.processed, succeeded: progress.succeeded,
      unavailable:progress.unavailable ?? 0, failed: progress.failed, status: progress.status} : null;
  }
  const updateProgress = value => {
    // Counts only: no student identifiers, responses, credentials, or results on the page.
    if (progressKey) globalThis[progressKey] = value;
  };
  const summary = {
    version: 3, source: "authenticated_zhixue_api", started_at: new Date().toISOString(),
    status: "running", endpoints: [], authentication: "not_verified",
    exams: "not_verified", roster: "not_verified", question_records: "not_verified",
    question_text: "not_verified", reference_answers: "not_verified",
  };
  let token = "";
  let role = "";
  const mainOrigin = "https://www.zhixue.com";
  const backend = "https://ali-bg.zhixue.com";
  const allowed = new Set([
    "/container/getCurrentUser", "/container/app/token/getToken",
    "/api-classreport/class/getAcademicTermTeachingCycle/",
    "/api-classreport/class/getUserTeachingInfos/",
    "/api-teacher/newContainer/getClassReportList",
    "/configure/class/getSubjectsIncludeSubAndGroup",
    "/api-classreport/class/singleScoreList/",
    "/api-classreport/class/getSubjectExamSummary/",
    "/api-classreport/class/student/getNewCheckSheet/",
    "/classreport/class/student/checksheet/",
  ]);
  const fail = (code) => { throw new Error(code); };
  const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  async function read(path, params = {}, asText = false) {
    if (!allowed.has(path)) fail("endpoint_not_allowed");
    const origin = path.startsWith("/container/") || asText ? mainOrigin : backend;
    const url = new URL(path, origin);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    url.searchParams.set("t", String(Date.now()));
    const headers = { "X-Requested-With": "XMLHttpRequest", Authorization: "true", report: "school" };
    if (token) headers.token = token;
    if (role) headers.role = role;
    const event = { host: url.hostname, path, status: "pending" };
    summary.endpoints.push(event);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 20000);
    try {
      const response = await fetch(url.href, {
        method: "GET", credentials: "include", redirect: "error", headers, signal: abort.signal,
      });
      event.http_status = response.status;
      if (!response.ok) fail(`http_${response.status}`);
      if (response.headers.get("tokenstatus") === "timeout") fail("session_expired");
      if (asText) { event.status = "received_html"; return await response.text(); }
      const value = await response.json();
      if (!Array.isArray(value) && (!value || typeof value !== "object")) fail("invalid_json_shape");
      if (value.errorCode !== undefined) {
        event.business_code = value.errorCode;
        if (![0, 1, 200, "0", "1", "200"].includes(value.errorCode)) fail(`business_error_${String(value.errorCode).replace(/[^\d-]/g, "").slice(0, 10)}`);
      }
      event.status = "received_json";
      const result = Object.hasOwn(value, "result") ? value.result : value;
      const knownFields = ["termTeachingCycleMap", "schoolId", "classPaperSummaryList", "pageInfoDTO", "gradeClassSubjectDTO", "studentAnswerRecords", "totalCount", "sheetDatas", "userAnswerRecordDTO", "answerRecordArchive", "archiveStatus"];
      event.known_result_fields = result && typeof result === "object" && !Array.isArray(result)
        ? knownFields.filter(key => Object.hasOwn(result, key)) : [];
      if (Array.isArray(result?.studentAnswerRecords)) event.first_student_has_user_id = result.studentAnswerRecords.length
        ? Boolean(result.studentAnswerRecords[0].userId) : null;
      return result;
    } catch (error) {
      event.status = "failed";
      // Do not serialize a URL, server response, token, or arbitrary error text.
      const message = /^(http_\d+|business_error_-?\d*|session_expired|invalid_json_shape)$/.test(error.message)
        ? error.message : error.name === "AbortError" ? "request_timeout" : "request_failed";
      event.error = message;
      fail(message);
    } finally { clearTimeout(timer); }
  }

  async function teachingScope() {
    const academic = await read("/api-classreport/class/getAcademicTermTeachingCycle/");
    const terms = Object.values(academic?.termTeachingCycleMap ?? {}).flat()
      .filter(item => item && item.id && item.termId)
      .sort((a, b) => Number(b.beginTime) - Number(a.beginTime));
    if (!terms.length || !academic.schoolId) fail("academic_schema_changed");
    const term = terms.find(item => Number(item.beginTime) <= Date.now() && Number(item.endTime) >= Date.now())
      ?? terms.find(item => Number(item.beginTime) <= Date.now()) ?? terms[0];
    const result = await read("/api-classreport/class/getUserTeachingInfos/", {
      searchType: "schoolYearType", circlesYear: "", termId: term.termId,
      teachingCycleId: term.id, startTime: term.beginTime, endTime: term.endTime,
    });
    if (!Array.isArray(result?.gradeClassSubjectDTO)) fail("teaching_scope_schema_changed");
    const classes = new Map();
    for (const grade of result.gradeClassSubjectDTO) {
      for (const row of grade.classes ?? []) {
        if (!row.classId) continue;
        const id = String(row.classId);
        const entry = classes.get(id) ?? {
          id, name: String(row.className ?? ""), gradeCode: String(grade.gradeCode ?? ""), subjects: [],
        };
        for (const subject of row.subjects ?? []) {
          if (subject.subjectCode == null || ["", "all", "00"].includes(String(subject.subjectCode)) || subject.subjectName === "总分") continue;
          const code = String(subject.subjectCode);
          if (!entry.subjects.some(item => item.code === code)) entry.subjects.push({code, name: String(subject.subjectName ?? "")});
        }
        if (entry.subjects.length) classes.set(id, entry);
      }
    }
    if (!classes.size) fail("no_teaching_scope");
    summary.teaching_scope = {
      status: "passed_live", source: "teacher_teaching_infos", class_count: classes.size,
      subject_count: new Set([...classes.values()].flatMap(row => row.subjects.map(subject => subject.code))).size,
    };
    return { academic, term, classes: [...classes.values()] };
  }

  async function scopedSubjects(examId, classes) {
    const result = await read("/configure/class/getSubjectsIncludeSubAndGroup", { examId });
    if (!Array.isArray(result)) fail("subjects_schema_changed");
    const allowedCodes = new Set(classes.flatMap(row => row.subjects.map(subject => subject.code)));
    const subjects = result.filter(row => row.topicSetId && row.subjectCode != null
      && allowedCodes.has(String(row.subjectCode)) && row.subjectName !== "总分" && !row.isSubjectGroup)
      .map(row => ({ id: String(row.topicSetId), name: String(row.subjectName), code: String(row.subjectCode) }));
    if (!subjects.length) fail("no_authorized_exam_subjects");
    return subjects;
  }

  function jsonVariable(html, name) {
    const match = new RegExp("\\b(?:var|let|const)\\s+" + name + "\\s*=\\s*").exec(html);
    if (!match) fail("missing_sheet_data");
    const start = match.index + match[0].length;
    let quoted = false, escaped = false, depth = 0;
    for (let i = start; i < html.length; i++) {
      const ch = html[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') quoted = false;
        continue;
      }
      if (ch === '"') quoted = true;
      else if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(html.slice(start, i + 1)); }
          catch { fail("invalid_sheet_data"); }
        }
      }
    }
    fail("invalid_sheet_data");
  }

  function parsePaper(html) {
    return parseRecords(jsonVariable(html, "sheetDatas"));
  }

  function parseStructuredPaper(value) {
    let root = value?.sheetDatas ?? value;
    if (typeof root === "string") {
      try { root = JSON.parse(root); } catch { fail("invalid_structured_sheet_data"); }
    }
    if (value?.answerRecordArchive?.answerRecordDetails) root = {userAnswerRecordDTO:value.answerRecordArchive};
    return parseRecords(root);
  }

  function parseRecords(root) {
    const records = root?.userAnswerRecordDTO?.answerRecordDetails;
    if (!Array.isArray(records) || !records.length) fail("missing_question_records");
    for (const row of records) {
      if (!row || !["score", "standardScore"].every(key => typeof row[key] === "number" && Number.isFinite(row[key]))
        || row.score < 0 || row.standardScore < row.score || !/^[0-9]+(?:[.．][0-9]+)*$/.test(String(row.topicNumber ?? ""))
        || typeof row.answerType !== "string") fail("invalid_question_fields");
    }
    if (new Set(records.map(row => String(row.topicNumber))).size !== records.length) fail("duplicate_question_numbers");
    return records.map(row => ({
      question_number: row.topicNumber,
      question_label: String(row.dispTitle ?? row.topicNumber),
      answer_type: row.answerType,
      // Subjective answers may be signed image URLs: never export those URLs.
      student_answer: row.answerType === "s01Text" ? String(row.answer ?? "") : null,
      subjective_answer_present: row.answerType === "s02Image" ? Boolean(row.answer) : null,
      score: row.score, full_score: row.standardScore,
      result: row.standardScore === 0 ? "not_scored" : row.score === row.standardScore ? "correct"
        : row.score === 0 ? "incorrect" : "partial_credit",
      lost_points: row.score < row.standardScore,
      reported_correct: typeof row.isCorrect === "boolean" ? row.isCorrect : null,
      subquestions: Array.isArray(row.subTopics) ? row.subTopics
        .filter(sub => typeof sub.score === "number" && Number.isFinite(sub.score))
        .map(sub => ({ index: sub.subTopicIndex ?? null, score: sub.score })) : [],
    }));
  }

  try {
    if (location.origin !== mainOrigin) fail("open_authenticated_zhixue_tab");
    const user = await read("/container/getCurrentUser");
    if (!user || user.role !== "teacher") fail("teacher_session_required");
    role = user.role;
    summary.authentication = "verified_teacher_session";
    const tokenValue = await read("/container/app/token/getToken");
    if (typeof tokenValue !== "string" || !tokenValue) fail("missing_session_token");
    token = tokenValue;

    if (command.action === "connect") {
      const scope = await teachingScope();
      const { academic, term: latest, classes } = scope;
      const singleClass = classes.length === 1 ? classes[0] : null;
      const codes = [...new Set(classes.flatMap(row => row.subjects.map(subject => subject.code)))];
      const result = await read("/api-teacher/newContainer/getClassReportList", {
        type: "academicYear", keyWord: "", startTime: latest.beginTime, endTime: latest.endTime,
        pageIndex: 1, pageSize: 30, classId: singleClass?.id ?? "", currentDayTime: Date.now(), subjectCode: codes.length === 1 ? codes[0] : "all",
        gradeCode: singleClass?.gradeCode || "all", role, examTypeCodes: "", examName: "", timeRange: "all",
        searchType: "schoolYearType", circlesYear: "", termId: latest.termId,
        teachingCycleId: latest.id, schoolId: academic.schoolId, orderField: "examDateTime", orderAsc: false,
      });
      const exams = result?.classPaperSummaryList;
      if (!Array.isArray(exams)) fail("exam_list_schema_changed");
      const options = exams.filter(exam => exam.examId || exam.data?.examId).map(exam => ({
        id: String(exam.examId ?? exam.data.examId),
        name: String(exam.examName ?? exam.data?.examName ?? "未命名考试"),
      }));
      summary.exams = { status: options.length ? "passed_live" : "empty", count: options.length, scope: "latest_term_first_page" };
      summary.status = options.length ? "connected" : "no_exams_in_latest_term";
      return { ok: true, summary, options, teachingClasses: classes };
    }

    if (command.action === "subjects") {
      const scope = await teachingScope();
      const subjects = await scopedSubjects(command.examId, scope.classes);
      summary.status = "subjects_received";
      return { ok: true, summary, subjects, teachingClasses: scope.classes };
    }

    if (command.action === "classes") {
      const scope = await teachingScope();
      if (typeof command.subjectCode !== "string" || !command.subjectCode) fail("subject_code_required");
      const classes = scope.classes.filter(row => row.subjects.some(subject => subject.code === command.subjectCode));
      if (!classes.length) fail("no_accessible_classes");
      summary.status = "classes_received";
      return { ok: true, summary, classes };
    }

    if (command.action !== "export") fail("unknown_action");
    if (![command.examId, command.subjectId, command.classId].every(value => typeof value === "string" && value)) fail("selection_required");
    const scope = await teachingScope();
    const selectedClass = scope.classes.find(row => row.id === command.classId);
    if (!selectedClass) fail("class_outside_teaching_scope");
    const subjects = await scopedSubjects(command.examId, [selectedClass]);
    const selectedSubject = subjects.find(row => row.id === command.subjectId);
    if (!selectedSubject) fail("subject_outside_teaching_scope");
    const result = await read("/api-classreport/class/singleScoreList/", {
      examId: command.examId, classId: command.classId, topicSetId: selectedSubject.id,
      orderField: "", order: "", searchKeyName: "", cmpToExamId: "", historyReportFlag: "",
    });
    const rows = result?.studentAnswerRecords;
    if (!Array.isArray(rows)) fail("class_roster_schema_changed");
    if (result.totalCount != null && Number(result.totalCount) !== rows.length) fail("class_roster_incomplete");
    const unique = new Map();
    for (const row of rows) {
      if (row.classId !== undefined && String(row.classId) !== command.classId) fail("class_mismatch");
      if (row.subjectCode != null && String(row.subjectCode) !== selectedSubject.code) fail("subject_mismatch");
      if (row.topicSetId != null && String(row.topicSetId) !== selectedSubject.id) fail("subject_paper_mismatch");
      const id = row.userId;
      if (id !== undefined && id !== null && String(id)) unique.set(String(id), row);
    }
    if (!rows.length) fail("empty_roster");
    if (unique.size !== rows.length) fail("roster_student_ids_missing_or_duplicated");
    summary.roster = { status: "passed_live", student_count: unique.size, scope: "selected_teaching_class_and_subject", source: "class_single_score_list" };
    const metric = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
    let overview = {status:"unavailable", class_max:null, class_avg:null, grade_max:null, grade_avg:null};
    try {
      const stats = await read("/api-classreport/class/getSubjectExamSummary/", {
        examId: command.examId, classId: command.classId, topicSetId: selectedSubject.id, historyReportFlag: "",
      });
      overview = {status:"received", class_max:metric(stats?.clsTopScore), class_avg:metric(stats?.clsAvgScore),
        grade_max:metric(stats?.schTopSCore), grade_avg:metric(stats?.schAvgScore)};
    } catch { /* The optional overview must not prevent importing the class. */ }
    const rank = value => {
      const n = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
      return Number.isSafeInteger(n) && n > 0 ? n : null;
    };
    const students = [];
    const unavailableStudents = [];
    const failures = [];
    const fullClass = command.fullClass === true;
    const sample = fullClass ? [...unique.entries()] : [...unique.entries()].slice(0, 3);
    let expectedSignature;
    let aborted = false;
    let processed = 0;
    let retries = 0;
    let structuredFallbacks = 0;
    const accountedCount = () => students.length + unavailableStudents.length;
    updateProgress({total:sample.length, processed:0, succeeded:0, unavailable:0, failed:0, status:"reading"});
    for (let i = 0; i < sample.length; i++) {
      const [userId, row] = sample[i];
      // The teacher score column explicitly reports this state; never infer it from a request failure.
      const studentName = String(row.userName ?? row.userInfo?.userName ?? "");
      const notScanned = typeof row.score === "string" && row.score.trim() === "没扫";
      // Same rule as the official class score page (canViewPaper): an explicit hasOriginPaper wins,
      // otherwise rank codes -2 and -3 mean no original paper. Such students are not judged.
      const rankCode = Number(row.rank);
      const noOriginalPaper = !notScanned && (typeof row.hasOriginPaper === "boolean"
        ? !row.hasOriginPaper : rankCode === -2 || rankCode === -3);
      if (notScanned || noOriginalPaper) {
        unavailableStudents.push(notScanned
          ? {student_id:userId,student_name:studentName,availability:"not_scanned",reason_source:"roster_score_column",score_label:"没扫",questions:[]}
          : {student_id:userId,student_name:studentName,availability:"no_original_paper",
            reason_source:typeof row.hasOriginPaper === "boolean" ? "roster_has_origin_paper" : "roster_rank_code",
            roster_score:typeof row.score === "number" && Number.isFinite(row.score) ? row.score : null,
            rank_code:Number.isFinite(rankCode) && rankCode < 0 ? rankCode : null,questions:[]});
        processed++;
        updateProgress({total:sample.length,processed,succeeded:students.length,unavailable:unavailableStudents.length,failed:failures.length,status:"reading"});
        continue;
      }
      try {
        let html;
        try {
          html = await read("/classreport/class/student/checksheet/", {userId, paperId: command.subjectId}, true);
        } catch (error) {
          if (!/^(request_timeout|request_failed|http_5\d\d)$/.test(error.message)) throw error;
          await wait(800);
          retries++;
          html = await read("/classreport/class/student/checksheet/", {userId, paperId: command.subjectId}, true);
        }
        let questions;
        try { questions = parsePaper(html); }
        catch (parseError) {
          if (!/^(missing_sheet_data|invalid_sheet_data|missing_question_records)$/.test(parseError.message)) throw parseError;
          structuredFallbacks++;
          const value = await read("/api-classreport/class/student/getNewCheckSheet/", {
            userId, topicSetId: command.subjectId, examId: command.examId,
          });
          questions = parseStructuredPaper(value);
        }
        const signature = JSON.stringify(questions.map(question => [String(question.question_number),question.full_score])
          .sort((a,b) => a[0].localeCompare(b[0],"en",{numeric:true})));
        if (expectedSignature !== undefined && expectedSignature !== signature) fail("question_number_or_full_score_mismatch");
        expectedSignature = signature;
        if (fullClass) for (const question of questions) {
          delete question.student_answer;
          delete question.subjective_answer_present;
        }
        students.push({ student_id: userId, student_name: studentName, questions,
          roster_score:metric(row.score),
          class_rank:result.permission?.classRankEnable === true ? rank(row.rank) : null,
          grade_rank:result.permission?.schoolRankEnable === true && result.isShowSchoolRank === true ? rank(row.schoolRank) : null });
      } catch (error) {
        failures.push({ sample_index: i + 1, code: /^[a-z_0-9-]+$/.test(error.message) ? error.message : "paper_read_failed",
          roster_hints: {
            score_is_number: typeof row.score === "number" && Number.isFinite(row.score),
            has_original_paper: typeof row.hasOriginPaper === "boolean" ? row.hasOriginPaper : null,
            negative_rank: typeof row.rank === "number" ? row.rank < 0 : null,
          },
        });
        if (/^(session_expired|http_401|http_403|business_error_)/.test(error.message)) aborted = true;
      }
      processed++;
      updateProgress({total:sample.length,processed,succeeded:students.length,unavailable:unavailableStudents.length,failed:failures.length,status:aborted?"stopped":"reading"});
      if (aborted) break;
      if (i < sample.length - 1) await wait(300);
    }
    summary.question_records = {
      status: accountedCount() === sample.length ? fullClass ? "passed_live_full_class" : "passed_live_sample" : students.length ? "partial" : "failed",
      requested_students: sample.length, exported_students: students.length,
      question_count: students.reduce((sum, student) => sum + student.questions.length, 0), failures,
      processed_students: processed, unprocessed_students: sample.length-processed, retried_requests: retries,
      structured_fallback_requests: structuredFallbacks,
      not_scanned_students: unavailableStudents.filter(row => row.availability === "not_scanned").length,
      no_original_paper_students: unavailableStudents.filter(row => row.availability === "no_original_paper").length,
      accounted_students: accountedCount(),
    };
    summary.question_alignment = {
      status: accountedCount() === sample.length ? students.length ? "consistent_across_exported_class" : "no_scanned_students" : "incomplete",
      question_numbers: students[0]?.questions.map(question => question.question_number) ?? [],
      teacher_uploaded_paper_match: "not_verified",
    };
    const counts = {correct:0,incorrect:0,partial_credit:0,not_scored:0};
    for (const student of students) for (const question of student.questions) counts[question.result]++;
    summary.result_counts = counts;
    summary.export_scope = fullClass ? "full_class_scores_only" : "three_student_sample";
    summary.status = accountedCount() === sample.length ? fullClass ? "passed_live_full_class_export" : "passed_live_sample_export" : "incomplete_live_export";
    summary.finished_at = new Date().toISOString();
    return {
      ok: accountedCount() === sample.length, summary,
      data: { exam_id: command.examId, subject_id: command.subjectId, class_id: command.classId, overview, students, unavailable_students: unavailableStudents },
    };
  } catch (error) {
    summary.status = "failed";
    summary.error = /^[a-z_0-9-]+$/.test(error.message) ? error.message : "unexpected_error";
    return { ok: false, summary };
  } finally {
    token = "";
    if (progressKey && globalThis[progressKey]) globalThis[progressKey].status = summary.status;
  }
}
