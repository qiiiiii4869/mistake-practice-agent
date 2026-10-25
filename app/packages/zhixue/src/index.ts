// Full-class reads include scores only; secrets stay inside the authenticated webview.
// The existing browser-probe remains the single source for authenticated reads.
export interface Exam { id: string; name: string }
export interface TeachingClass {
  id: string;
  name: string;
  subjects: { code: string; name: string }[];
}
export interface Endpoint {
  host: string;
  path: string;
  status: string;
  http_status?: number;
  business_code?: number | string;
  error?: string;
}
export interface ConnectionReport {
  ok: boolean;
  summary: {
    status: string;
    authentication: string;
    error?: string;
    endpoints: Endpoint[];
    exams?: string | { status: string; count: number; scope: string };
  };
  options: Exam[];
  teachingClasses: TeachingClass[];
}
export interface LoginStatus {
  open: boolean;
  host: string | null;
  captcha_60500: boolean;
}
export interface ExamSubject { id: string; name: string; code: string }
export interface SubjectReport {
  ok: boolean;
  summary: { error?: string };
  subjects?: ExamSubject[];
  teachingClasses?: TeachingClass[];
}

export const errorMessage = (code: string): string => {
  const messages: Record<string, string> = {
    teacher_session_required: '还未确认教师登录。请在智学网窗口完成登录，再读取考试。',
    open_authenticated_zhixue_tab: '请先在智学网窗口完成登录，回到 www.zhixue.com 页面。',
    login_window_not_open: '请先打开智学网登录窗口。',
    login_window_closed: '智学网窗口已关闭，请重新打开并读取。',
    session_expired: '智学网登录已过期，请重新登录。',
    request_timeout: '请求超时，请检查网络后重试。',
    request_failed: '接口请求失败，请检查智学网窗口是否已登录、网络是否正常。',
    probe_timeout: '读取未能在两分钟内完成，请稍后重试。',
    probe_page_changed: '读取期间智学网页面发生了跳转，请等页面稳定后重试。',
    probe_busy: '上一次读取仍在进行，请等待完成。',
    no_teaching_scope: '当前账号未返回任教范围，请确认使用的是任课教师账号。',
    diagnostic_not_ready: '请先读取一次考试列表，再保存诊断。',
    full_class_timeout: '全班读取超过 30 分钟仍未完成，本次数据没有保存。请检查网络后重试。',
  };
  if (code.includes('60500')) return '智学网返回 60500，内置登录尚未通过，可使用 Chrome 扩展导入作为备用入口。';
  if (/^business_error_-?\d+$/.test(code)) return `智学网接口返回业务错误（${code.replace('business_error_', '')}）。`;
  if (/^http_\d+$/.test(code)) return `智学网接口返回 HTTP ${code.slice(5)}。`;
  return messages[code] ?? `暂未通过验证（${/^[a-z0-9_-]{1,80}$/.test(code) ? code : 'desktop_error'}）。`;
};
