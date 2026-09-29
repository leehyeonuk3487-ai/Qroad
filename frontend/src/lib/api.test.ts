import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestPlan } from './api';
import type { CanonicalVisit, TripSettings } from '../types';

const visits: CanonicalVisit[] = [
  { id: 'row-2', source_row: 2, label: '가나상사', address: '서울특별시 중구 세종대로 110' },
];
const settings: TripSettings = { trip_days: 1, departure_time: '09:00', default_service_minutes: 30, minutes_per_task: 0 };

function respondWith(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('requestPlan', () => {
  it('sends only the canonical visit payload', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ days: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await requestPlan(visits, settings);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/plan');
    expect(JSON.parse(String(init.body))).toEqual({ visits, settings });
  });

  it('surfaces a string detail as written', async () => {
    respondWith(422, { detail: '방문지 목록을 확인해 주세요.' });

    await expect(requestPlan(visits, settings)).rejects.toThrow('방문지 목록을 확인해 주세요.');
  });

  it('never shows "[object Object]" for a list-shaped validation body', async () => {
    respondWith(422, { detail: [{ loc: ['body', 'visits'], msg: 'List should have at most 200 items' }] });

    const error = await requestPlan(visits, settings).catch((caught: Error) => caught);

    expect(String(error)).not.toContain('[object Object]');
    expect(String(error)).toContain('List should have at most 200 items');
  });

  it('explains a server fault differently from a connection fault', async () => {
    respondWith(500, {});

    await expect(requestPlan(visits, settings)).rejects.toThrow('서버가 경로를 계산하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  });

  it('falls back to a readable sentence when the body is not JSON at all', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>502</html>', { status: 502 })));

    const error = await requestPlan(visits, settings).catch((caught: Error) => caught);

    expect(String(error)).toContain('서버가');
  });
});
