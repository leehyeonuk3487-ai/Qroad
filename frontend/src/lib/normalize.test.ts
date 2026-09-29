import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { emptyMapping, inferMapping, normalizeVisits, readWorkbook, textToSheet } from './normalize';
import type { ColumnMapping, SheetData } from '../types';

/** Round-trips rows through a real .xlsx file so the parser is exercised the way a user's upload is. */
async function readRows(rows: unknown[][], merges: XLSX.Range[] = []): Promise<SheetData> {
  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  if (merges.length) worksheet['!merges'] = merges;
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, '출장');
  const buffer = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  const imported = await readWorkbook(new File([buffer], '출장계획.xlsx'));
  return imported.sheets[0];
}

function mappingOf(overrides: Partial<ColumnMapping>): ColumnMapping {
  return { ...emptyMapping(), ...overrides };
}

describe('inferMapping', () => {
  it('matches the column names a Korean field-visit sheet actually uses', () => {
    const mapping = inferMapping(['연번', '납세자주소', '상호', '방문순서', '체류시간', '업무건수']);

    expect(mapping.address).toBe('납세자주소');
    expect(mapping.label).toBe('상호');
    expect(mapping.order).toBe('방문순서');
    expect(mapping.serviceMinutes).toBe('체류시간');
    expect(mapping.taskCount).toBe('업무건수');
  });

  it('leaves region and detail unset once a full address column is found', () => {
    const mapping = inferMapping(['주소', '시군구', '상세주소']);

    expect(mapping.address).toBe('주소');
    expect(mapping.addressRegion).toBe('');
    expect(mapping.addressDetail).toBe('');
  });

  it('returns no guess when nothing resembles an address', () => {
    expect(inferMapping(['비고', '담당자', '전화']).address).toBe('');
  });
});

describe('readWorkbook', () => {
  it('finds the header row below a merged title banner', async () => {
    const sheet = await readRows([
      ['2026년 상반기 현장 출장 계획'],
      [],
      ['일자', '기관명', '납세자주소', '방문순서'],
      ['1일차', '가나상사', '서울특별시 중구 세종대로 110', '1'],
    ]);

    expect(sheet.headers).toEqual(['일자', '기관명', '납세자주소', '방문순서']);
    expect(sheet.rows).toHaveLength(1);
  });

  it('carries a merged day cell down to the rows it spans', async () => {
    const sheet = await readRows(
      [
        ['일자', '주소'],
        ['1일차', '서울특별시 중구 세종대로 110'],
        ['', '서울특별시 종로구 사직로 161'],
      ],
      [{ s: { r: 1, c: 0 }, e: { r: 2, c: 0 } }],
    );

    expect(sheet.rows[1][0]).toBe('1일차');
  });

  it('gives duplicated header names distinct labels so they stay selectable', async () => {
    const sheet = await readRows([
      ['주소', '주소', '비고'],
      ['서울특별시 중구 세종대로 110', '2층', 'x'],
    ]);

    expect(new Set(sheet.headers).size).toBe(sheet.headers.length);
  });
});

describe('normalizeVisits', () => {
  it('emits only the confirmed fields and never an unmapped column', async () => {
    const sheet = await readRows([
      ['주소', '기관명', '주민등록번호', '연락처'],
      ['서울특별시 중구 세종대로 110', '가나상사', '900101-1234567', '010-0000-0000'],
    ]);

    const visits = normalizeVisits(sheet, mappingOf({ address: '주소', label: '기관명' }));

    expect(visits).toHaveLength(1);
    const serialized = JSON.stringify(visits);
    expect(serialized).not.toContain('900101');
    expect(serialized).not.toContain('010-0000-0000');
    expect(Object.keys(visits[0]).sort()).toEqual(['address', 'id', 'label', 'source_row'].sort());
  });

  it('points source_row back at the spreadsheet row the visit came from', async () => {
    const sheet = await readRows([
      ['안내문'],
      ['주소'],
      ['서울특별시 중구 세종대로 110'],
      ['서울특별시 종로구 사직로 161'],
    ]);

    const visits = normalizeVisits(sheet, mappingOf({ address: '주소' }));

    expect(visits.map((visit) => visit.source_row)).toEqual([3, 4]);
  });

  it('drops rows with no address rather than inventing one', async () => {
    const sheet = await readRows([
      ['주소', '기관명'],
      ['서울특별시 중구 세종대로 110', '가나상사'],
      ['', '주소없는상사'],
    ]);

    const visits = normalizeVisits(sheet, mappingOf({ address: '주소', label: '기관명' }));

    expect(visits).toHaveLength(1);
    expect(visits[0].label).toBe('가나상사');
  });

  it('joins a region column with a detail column when no full address exists', async () => {
    const sheet = await readRows([
      ['시군구', '상세주소'],
      ['대구광역시 중구', '공평로 88'],
    ]);

    const visits = normalizeVisits(sheet, mappingOf({ addressRegion: '시군구', addressDetail: '상세주소' }));

    expect(visits[0].address).toBe('대구광역시 중구 공평로 88');
  });

  it('reads "N일차" and bare numbers as day numbers', async () => {
    const sheet = await readRows([
      ['일자', '주소'],
      ['2일차', '서울특별시 중구 세종대로 110'],
      ['3', '서울특별시 종로구 사직로 161'],
    ]);

    const visits = normalizeVisits(sheet, mappingOf({ address: '주소', day: '일자' }));

    expect(visits.map((visit) => visit.original_day)).toEqual([2, 3]);
  });

  it('numbers distinct visit dates in calendar order', async () => {
    const sheet = await readRows([
      ['방문일자', '주소'],
      ['2026-03-11', '서울특별시 중구 세종대로 110'],
      ['2026-03-09', '서울특별시 종로구 사직로 161'],
      ['2026-03-11', '서울특별시 용산구 이태원로 22'],
    ]);

    const visits = normalizeVisits(sheet, mappingOf({ address: '주소', day: '방문일자' }));

    expect(visits.map((visit) => visit.original_day)).toEqual([2, 1, 2]);
  });

  it('converts stay times written in hours and minutes', async () => {
    const sheet = await readRows([
      ['주소', '체류시간'],
      ['서울특별시 중구 세종대로 110', '1시간 30분'],
      ['서울특별시 종로구 사직로 161', '45분'],
      ['서울특별시 용산구 이태원로 22', '2시간'],
    ]);

    const visits = normalizeVisits(sheet, mappingOf({ address: '주소', serviceMinutes: '체류시간' }));

    expect(visits.map((visit) => visit.service_minutes)).toEqual([90, 45, 120]);
  });

  it('falls back to the address as the label when no name column is mapped', async () => {
    const sheet = await readRows([
      ['주소'],
      ['서울특별시 중구 세종대로 110'],
    ]);

    const visits = normalizeVisits(sheet, mappingOf({ address: '주소' }));

    expect(visits[0].label).toBe('서울특별시 중구 세종대로 110');
  });
});

describe('textToSheet', () => {
  it('turns pasted lines into addressable rows and ignores blank lines', () => {
    const sheet = textToSheet('서울특별시 중구 세종대로 110\n\n  서울특별시 종로구 사직로 161  \n');

    const visits = normalizeVisits(sheet, mappingOf({ address: '주소' }));

    expect(visits.map((visit) => visit.address)).toEqual([
      '서울특별시 중구 세종대로 110',
      '서울특별시 종로구 사직로 161',
    ]);
  });
});

describe('source row tracking', () => {
  it('reports the real spreadsheet row even when blank rows sit between visits', async () => {
    const sheet = await readRows([
      ['주소', '기관명'],                    // row 1, header
      ['서울특별시 중구 세종대로 110', 'A'],  // row 2
      ['', ''],                              // row 3, blank separator
      ['서울특별시 종로구 사직로 161', 'B'],  // row 4
      ['', ''],                              // row 5
      ['서울특별시 용산구 이태원로 22', 'C'], // row 6
    ]);

    const visits = normalizeVisits(sheet, mappingOf({ address: '주소', label: '기관명' }));

    expect(visits.map((visit) => visit.source_row)).toEqual([2, 4, 6]);
    expect(visits.map((visit) => visit.id)).toEqual(['row-2', 'row-4', 'row-6']);
  });

  it('keeps row numbers aligned with the rows that were kept', async () => {
    const sheet = await readRows([
      ['설명 행'],
      ['주소'],
      ['서울특별시 중구 세종대로 110'],
      [''],
      ['서울특별시 종로구 사직로 161'],
    ]);

    expect(sheet.rowNumbers).toEqual([3, 5]);
    expect(sheet.rows).toHaveLength(2);
  });
});

describe('column alias coverage', () => {
  it.each([
    ['출장지', 'label'],
    ['방문처', 'label'],
    ['소재지', 'address'],
    ['납세자주소', 'address'],
  ] as const)('recognises %s as %s', (header, field) => {
    expect(inferMapping([header, '비고'])[field]).toBe(header);
  });
});
