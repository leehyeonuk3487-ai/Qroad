import { describe, expect, it } from 'vitest';
import { buildAnnotatedRows, buildAttentionRows } from './export';
import type { DayPlan, PlanResponse, PlannedVisit, SheetData } from '../types';

function visit(overrides: Partial<PlannedVisit> & Pick<PlannedVisit, 'id' | 'geocode_status'>): PlannedVisit {
  return {
    source_row: 2,
    label: '가나상사',
    address: '서울특별시 중구 세종대로 110',
    geocode_candidates: [],
    ...overrides,
  } as PlannedVisit;
}

function response(visits: PlannedVisit[], issues: PlanResponse['issues'] = []): PlanResponse {
  return {
    visits,
    days: [],
    issues,
    matrix_source: 'kakao_road',
    partition_basis: '',
    optimization_status: 'partial',
  };
}

describe('buildAttentionRows', () => {
  it('keeps every visit that never made it onto a route', () => {
    const result = response(
      [
        visit({ id: 'a', geocode_status: 'matched' }),
        visit({ id: 'b', source_row: 3, geocode_status: 'unmatched' }),
        visit({ id: 'c', source_row: 4, geocode_status: 'review' }),
      ],
      [{ kind: 'unmatched_address', severity: 'error', visit_id: 'b', message: '주소를 찾지 못했습니다.' }],
    );

    const rows = buildAttentionRows(result);

    expect(rows.map((row) => row.원본행)).toEqual([3, 4]);
    expect(rows[0].주소확인).toBe('주소 미확인');
    expect(rows[0].안내).toBe('주소를 찾지 못했습니다.');
    expect(rows[1].주소확인).toBe('장소명 검색 · 확인 필요');
  });

  it('lists the candidate addresses so the row can be corrected from the file', () => {
    const result = response([
      visit({
        id: 'c',
        geocode_status: 'review',
        geocode_candidates: [
          { label: '가나상사', address: '서울특별시 중구 세종대로 110', coordinate: { longitude: 126.9, latitude: 37.5 }, source: 'keyword' },
          { label: '가나상사 2호점', address: '서울특별시 종로구 사직로 161', coordinate: { longitude: 126.9, latitude: 37.5 }, source: 'keyword' },
        ],
      }),
    ]);

    expect(buildAttentionRows(result)[0].후보주소).toBe(
      '서울특별시 중구 세종대로 110 | 서울특별시 종로구 사직로 161',
    );
  });

  it('produces no sheet content when every address resolved', () => {
    expect(buildAttentionRows(response([visit({ id: 'a', geocode_status: 'matched' })]))).toEqual([]);
  });
});

function day(overrides: Partial<DayPlan> = {}): DayPlan {
  return {
    day_number: 1,
    status: 'optimized',
    basis: '',
    stops: [],
    optimized_metrics: { distance_meters: 0, duration_seconds: 0 },
    polyline: [],
    baseline_order: [],
    service_minutes_total: 0,
    estimated_leg_count: 0,
    review_visit_count: 0,
    ...overrides,
  };
}

const sourceSheet: SheetData = {
  name: '출장',
  headerRowIndex: 1,
  headers: ['주소', '기관명'],
  rows: [['서울특별시 중구 세종대로 110', 'A'], ['서울특별시 종로구 사직로 161', 'B']],
  rowNumbers: [3, 5],
  rawRows: [
    ['2026년 출장 계획'],
    ['주소', '기관명'],
    ['서울특별시 중구 세종대로 110', 'A'],
    ['', ''],
    ['서울특별시 종로구 사직로 161', 'B'],
  ],
};

describe('buildAnnotatedRows', () => {
  const result: PlanResponse = {
    ...response([
      visit({ id: 'row-3', source_row: 3, geocode_status: 'matched', label: 'A' }),
      visit({ id: 'row-5', source_row: 5, geocode_status: 'unmatched', label: 'B' }),
    ]),
    days: [
      day({
        stops: [
          {
            visit_id: 'row-3',
            optimized_order: 1,
            label: 'A',
            address: '서울특별시 중구 세종대로 110',
            arrival_time: '09:20',
            departure_time: '09:50',
            travel_seconds_from_previous: 1200,
            travel_distance_meters_from_previous: 8400,
            travel_is_estimated: false,
            travel_from_start: false,
            service_minutes: 30,
          },
        ],
      }),
    ],
  };

  it('keeps the original rows in place and appends result columns to the header', () => {
    const rows = buildAnnotatedRows(sourceSheet, result);

    expect(rows).toHaveLength(sourceSheet.rawRows.length);
    expect(rows[0][0]).toBe('2026년 출장 계획');
    expect(rows[1]).toContain('Qroad_방문순서');
    expect(rows[1].slice(0, 2)).toEqual(['주소', '기관명']);
  });

  it('writes each visit onto the spreadsheet row it came from, past blank rows', () => {
    const rows = buildAnnotatedRows(sourceSheet, result);
    const header = rows[1] as string[];
    const orderColumn = header.indexOf('Qroad_방문순서');
    const checkColumn = header.indexOf('Qroad_주소확인');

    expect(rows[2][orderColumn]).toBe(1);        // spreadsheet row 3 = visit A
    expect(rows[3][orderColumn]).toBe('');       // the blank row stays blank
    expect(rows[4][checkColumn]).toBe('주소 미확인'); // row 5 is flagged even with no route
  });

  it('leaves rows above the header untouched', () => {
    const rows = buildAnnotatedRows(sourceSheet, result);

    expect(rows[0]).not.toContain('Qroad_일차');
  });
});
