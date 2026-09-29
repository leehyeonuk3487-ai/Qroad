import type { CanonicalVisit, PlanResponse, TripSettings } from '../types';

// Empty by default: local dev serves the frontend and backend from one origin (Vite's
// dev proxy makes '/api/plan' reach the backend). A production build has no such proxy,
// so a deployed frontend needs the backend's real URL here, e.g. https://qroad-api.onrender.com.
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ?? '';

export async function requestPlan(visits: CanonicalVisit[], settings: TripSettings): Promise<PlanResponse> {
  const response = await fetch(`${API_BASE_URL}/api/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visits, settings }),
  });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  return response.json() as Promise<PlanResponse>;
}

/**
 * A rejected request can answer with a string detail, a list of validation errors,
 * or no JSON at all. Rendering any of those straight into the UI shows the user
 * "[object Object]", so each shape is reduced to a sentence here.
 */
async function readErrorMessage(response: Response): Promise<string> {
  const fallback =
    response.status >= 500
      ? '서버가 경로를 계산하지 못했습니다. 잠시 후 다시 시도해 주세요.'
      : '경로 계산 요청에 실패했습니다. 서버 연결을 확인해 주세요.';
  const body: unknown = await response.json().catch(() => null);
  if (typeof body !== 'object' || body === null || !('detail' in body)) return fallback;

  const { detail } = body as { detail: unknown };
  if (typeof detail === 'string' && detail.trim()) return detail;
  if (Array.isArray(detail)) {
    const messages = detail
      .map((entry) => (typeof entry === 'object' && entry && 'msg' in entry ? String((entry as { msg: unknown }).msg) : ''))
      .filter(Boolean);
    if (messages.length) return `${fallback} (${messages.slice(0, 3).join(' / ')})`;
  }
  return fallback;
}
