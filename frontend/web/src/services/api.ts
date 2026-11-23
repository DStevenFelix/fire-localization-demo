import type { Health, Mode, Poi, Session, SessionPosts } from '../types';
import { normalizeSession } from '../utils/poiRegistry';

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const timeout = AbortSignal.timeout(15000);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...init, signal, headers: { 'Content-Type': 'application/json', ...init.headers },
    });
  } catch (error) {
    if (timeout.aborted) throw new Error('桥接服务响应超时，请检查服务连接；页面不会自动重新提交定位请求。');
    throw error;
  }
  if (!response.ok) {
    let message = `桥接服务请求失败（HTTP ${response.status}）`;
    try { const body = await response.json(); if (typeof body.detail === 'string') message = body.detail; } catch { /* use status */ }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}
export const api = {
  health: () => request<Health>('/health'),
  pois: () => request<Poi[]>('/pois'),
  scenarios: () => request<{ scenarios: Poi[]; default_target_poi_id: string }>('/scenarios'),
  active: () => request<Session | null>('/scenarios/active').then(value => value && normalizeSession(value)),
  prepare: (target_poi_id: string, mode: Mode, seed: number, signal?: AbortSignal) => request<Session>('/scenarios/prepare', {
    method: 'POST', body: JSON.stringify({ target_poi_id, mode, seed, source: 'socialnet' }), signal,
  }).then(normalizeSession),
  run: (session_id: string, confirm_paid_api = false, paused = false) => request<Session>('/localization/run', {
    method: 'POST', body: JSON.stringify({ session_id, confirm_paid_api, ...(paused && { paused }) }),
  }).then(normalizeSession),
  session: (id: string) => request<Session>(`/localization/${encodeURIComponent(id)}`).then(normalizeSession),
  posts: (id: string, signal?: AbortSignal) => request<SessionPosts>(`/localization/${encodeURIComponent(id)}/posts`, { signal }),
  reset: (id: string) => request<Session>(`/localization/${encodeURIComponent(id)}/reset`, { method: 'POST', body: '{}' }).then(normalizeSession),
  handoff: (id: string) => request<Session>(`/localization/${encodeURIComponent(id)}/handoff`, { method: 'POST' }).then(normalizeSession),
  stop: (id: string) => request<Session>(`/localization/${encodeURIComponent(id)}/stop`, { method: 'POST' }).then(normalizeSession),
  setPause: (id: string, paused: boolean) => request<Session>(`/localization/${encodeURIComponent(id)}/pause`, {
    method: 'PUT', body: JSON.stringify({ paused }),
  }).then(normalizeSession),
};
