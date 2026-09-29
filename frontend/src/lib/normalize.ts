import * as XLSX from 'xlsx';
import type { CanonicalVisit, ColumnMapping, FieldKey, ImportedWorkbook, SheetData } from '../types';

export const fieldLabels: Record<FieldKey, string> = {
  label: '방문지 / 기관명',
  address: '전체 주소',
  addressRegion: '시군구 / 지역',
  addressDetail: '상세 주소',
  day: '기존 일차',
  order: '기존 방문순서',
  serviceMinutes: '체류시간(분)',
  taskCount: '업무 건수',
  timeHint: '시간 정보',
};

// Real sheets name the same column many ways, so matching is by keyword rather than
// by a fixed layout. Every entry here is a substring test, not an exact header name.
const aliases: Record<FieldKey, string[]> = {
  address: [
    '주소', '소재지', '주소지', '납세자주소', '방문주소', '도로명주소', '지번주소', '현주소',
    '사업장주소', '소재지주소', '위치', 'location', 'address', 'addr',
  ],
  label: [
    '방문지', '방문처', '출장지', '방문장소', '방문기관', '대상지', '대상기관', '장소', '기관명',
    '업체명', '사업장', '상호', '명칭', '거래처', '현장명', '현장', 'name', 'place',
  ],
  addressRegion: ['시군구', '시도', '시군', '구군', '지역', '지역명', '행정구역', '관할'],
  addressDetail: ['상세주소', '번지', '도로명', '건물명', '건물', '상세', '주소2'],
  day: ['일차', '방문일', '방문일자', '일정', '날짜', '출장일', '방문예정일', 'day', 'date'],
  order: ['방문순서', '순서', '방문순번', '순번', 'order', 'seq'],
  serviceMinutes: ['체류시간', '소요시간', '업무시간', '방문시간', '처리시간', '소요', 'duration'],
  taskCount: ['업무건수', '업무수', '처리건수', '업무량', '건수', 'task', 'count'],
  timeHint: ['방문시간대', '도착희망', '희망시간', '도착시간', '방문시각', '시간대', '시간', 'time'],
};

export const emptyMapping = (): ColumnMapping => ({
  label: '',
  address: '',
  addressRegion: '',
  addressDetail: '',
  day: '',
  order: '',
  serviceMinutes: '',
  taskCount: '',
  timeHint: '',
});

export function readWorkbook(file: File): Promise<ImportedWorkbook> {
  return file.arrayBuffer().then((buffer) => {
    const workbook = XLSX.read(buffer, { cellDates: false });
    const sheets = workbook.SheetNames.map((name) => readSheet(name, workbook.Sheets[name])).filter(
      (sheet) => sheet.rows.length > 0,
    );
    if (!sheets.length) throw new Error('읽을 수 있는 데이터 행이 없습니다.');
    return { filename: file.name, sheets };
  });
}

function readSheet(name: string, worksheet: XLSX.WorkSheet): SheetData {
  const rawRows = XLSX.utils.sheet_to_json<unknown[]>(worksheet, { header: 1, defval: '', raw: false });
  fillMergedCells(rawRows, worksheet);
  const headerRowIndex = findHeaderRow(rawRows);
  const rawHeaders = rawRows[headerRowIndex] ?? [];
  const headers = uniqueHeaders(rawHeaders.map((value, index) => clean(value) || `열 ${index + 1}`));
  // Blank separator rows are dropped, so each kept row records the spreadsheet row it came
  // from. Counting position in the filtered list instead makes every reported row number
  // drift past the first blank line, and those numbers are how a user finds the row to fix.
  const rows: string[][] = [];
  const rowNumbers: number[] = [];
  rawRows.slice(headerRowIndex + 1).forEach((row, offset) => {
    if (!row.some((value) => clean(value))) return;
    rows.push(headers.map((_, index) => clean(row[index])));
    rowNumbers.push(headerRowIndex + offset + 2);
  });
  return { name, headerRowIndex, headers, rows, rowNumbers, rawRows };
}

function fillMergedCells(rows: unknown[][], worksheet: XLSX.WorkSheet): void {
  for (const merge of worksheet['!merges'] ?? []) {
    const topValue = rows[merge.s.r]?.[merge.s.c] ?? '';
    for (let row = merge.s.r; row <= merge.e.r; row += 1) {
      rows[row] ??= [];
      for (let column = merge.s.c; column <= merge.e.c; column += 1) {
        if (!clean(rows[row][column])) rows[row][column] = topValue;
      }
    }
  }
}

function findHeaderRow(rows: unknown[][]): number {
  const sample = rows.slice(0, 40);
  let bestIndex = 0;
  let bestScore = -1;
  for (let index = 0; index < sample.length; index += 1) {
    const values = sample[index].map(clean).filter(Boolean);
    if (!values.length) continue;
    const recognized = values.reduce((total, value) => total + Number(isRecognizedHeader(value)), 0);
    const score = recognized * 12 + Math.min(values.length, 12) - Number(values.length === 1) * 5;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  return bestIndex;
}

function isRecognizedHeader(value: string): boolean {
  const normalized = normalizeHeader(value);
  return Object.values(aliases).flat().some((alias) => normalized.includes(normalizeHeader(alias)));
}

function uniqueHeaders(headers: string[]): string[] {
  const seen = new Map<string, number>();
  return headers.map((header) => {
    const number = (seen.get(header) ?? 0) + 1;
    seen.set(header, number);
    return number === 1 ? header : `${header} (${number})`;
  });
}

export function inferMapping(headers: string[]): ColumnMapping {
  const mapping = emptyMapping();
  (Object.keys(mapping) as FieldKey[]).forEach((field) => {
    let bestHeader = '';
    let bestScore = 0;
    headers.forEach((header) => {
      const score = aliases[field].reduce((highest, alias) => {
        const normalized = normalizeHeader(header);
        const keyword = normalizeHeader(alias);
        // The longer alias wins a tie, so '방문순서' is preferred over a bare '순서'
        // when a sheet happens to carry both.
        const base = normalized === keyword ? 100 : normalized.includes(keyword) ? 60 : 0;
        return Math.max(highest, base ? base + keyword.length : 0);
      }, 0);
      if (score > bestScore) {
        bestHeader = header;
        bestScore = score;
      }
    });
    mapping[field] = bestHeader;
  });
  // A detected full address is enough; region/detail columns only supplement it when manually selected.
  if (mapping.address) {
    mapping.addressRegion = '';
    mapping.addressDetail = '';
  }
  return mapping;
}

export function normalizeVisits(sheet: SheetData, mapping: ColumnMapping): CanonicalVisit[] {
  const indexOf = (field: FieldKey) => sheet.headers.indexOf(mapping[field]);
  const indexes = Object.fromEntries(
    (Object.keys(mapping) as FieldKey[]).map((field) => [field, indexOf(field)]),
  ) as Record<FieldKey, number>;
  const dateDays = dateDayLookup(sheet.rows, indexes.day);
  const visits: CanonicalVisit[] = [];

  sheet.rows.forEach((row, rowIndex) => {
    const value = (field: FieldKey) => (indexes[field] >= 0 ? clean(row[indexes[field]]) : '');
    const primaryAddress = value('address');
    const address = buildAddress(primaryAddress, value('addressRegion'), value('addressDetail'));
    if (!address) return;
    const label = value('label') || address;
    const day = parseDay(value('day'), dateDays);
    const order = parseInteger(value('order'));
    const serviceMinutes = parseMinutes(value('serviceMinutes'));
    const taskCount = parseInteger(value('taskCount'));
    const timeHint = value('timeHint') || undefined;
    const sourceRow = sheet.rowNumbers[rowIndex] ?? sheet.headerRowIndex + rowIndex + 2;
    visits.push({
      id: `row-${sourceRow}`,
      source_row: sourceRow,
      label,
      address,
      ...(day ? { original_day: day } : {}),
      ...(order ? { original_order: order } : {}),
      ...(serviceMinutes !== undefined ? { service_minutes: serviceMinutes } : {}),
      ...(taskCount !== undefined ? { task_count: taskCount } : {}),
      ...(timeHint ? { time_hint: timeHint } : {}),
    });
  });
  return visits;
}

export function textToSheet(text: string): SheetData {
  const addresses = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return {
    name: '직접 입력',
    headerRowIndex: 0,
    headers: ['주소'],
    rows: addresses.map((address) => [address]),
    rowNumbers: addresses.map((_, index) => index + 2),
    rawRows: [['주소'], ...addresses.map((address) => [address])],
  };
}

function dateDayLookup(rows: string[][], column: number): Map<string, number> {
  if (column < 0) return new Map();
  const dates = [...new Set(rows.map((row) => clean(row[column])).filter(isDateText))].sort();
  return new Map(dates.map((date, index) => [date, index + 1]));
}

function parseDay(value: string, dateDays: Map<string, number>): number | undefined {
  if (!value) return undefined;
  if (dateDays.has(value)) return dateDays.get(value);
  const dayText = value.match(/(\d+)\s*일\s*차/);
  if (dayText) return Number(dayText[1]);
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : undefined;
}

function parseInteger(value: string): number | undefined {
  const match = value.replace(/,/g, '').match(/\d+/);
  return match ? Number(match[0]) : undefined;
}

function parseMinutes(value: string): number | undefined {
  if (!value) return undefined;
  const hours = value.match(/(\d+(?:\.\d+)?)\s*시간/);
  const minutes = value.match(/(\d+)\s*분/);
  if (hours) return Math.round(Number(hours[1]) * 60) + (minutes ? Number(minutes[1]) : 0);
  return parseInteger(value);
}

function buildAddress(primary: string, region: string, detail: string): string {
  const values = primary ? [primary, detail].filter(Boolean) : [region, detail].filter(Boolean);
  return [...new Set(values)].join(' ').trim();
}

function isDateText(value: string): boolean {
  return /^\d{4}[./-]\d{1,2}[./-]\d{1,2}$/.test(value);
}

function clean(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[\s_()\-]/g, '');
}
