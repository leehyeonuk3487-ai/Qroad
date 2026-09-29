import * as XLSX from 'xlsx';
import type { PlanResponse, PlannedVisit, SheetData } from '../types';

export function exportPlan(source: SheetData | null, result: PlanResponse): void {
  const workbook = XLSX.utils.book_new();
  const visitById = new Map(result.visits.map((visit) => [visit.id, visit]));
  const planRows = result.days.flatMap((day) =>
    day.stops.map((stop) => {
      const visit = visitById.get(stop.visit_id);
      return {
        일차: day.day_number,
        최적방문순서: stop.optimized_order,
        원본행: visit?.source_row,
        방문지: stop.label,
        입력주소: visit?.address,
        확인주소: stop.address,
        예상도착: stop.arrival_time,
        예상출발: stop.departure_time,
        이전이동시간_분: Math.round(stop.travel_seconds_from_previous / 60),
        이전이동거리_km: Number((stop.travel_distance_meters_from_previous / 1000).toFixed(1)),
        이동시간근거: stop.travel_is_estimated ? '거리 기반 추정' : '카카오 도로',
        체류시간_분: stop.service_minutes,
        업무건수: stop.task_count ?? '',
        시간조건: describeTimeConstraint(stop),
        주소확인: geocodeLabel(visit),
        원본일차: visit?.original_day,
        원본방문순서: visit?.original_order,
        시간정보: visit?.time_hint,
      };
    }),
  );
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(planRows), '경로 계획');

  const summaryRows = result.days.map((day) => ({
    일차: day.day_number,
    출발지: day.start?.address ?? '',
    종료지: day.end?.address ?? '',
    방문지수: day.stops.length,
    계산상태: dayStatusLabel(day.status),
    최적이동시간_분: Math.round(day.optimized_metrics.duration_seconds / 60),
    최적이동거리_km: Number((day.optimized_metrics.distance_meters / 1000).toFixed(1)),
    체류시간합계_분: day.service_minutes_total,
    업무건수합계: day.task_count_total ?? '',
    추정구간수: day.estimated_leg_count,
    기존이동시간_분: day.baseline_metrics ? Math.round(day.baseline_metrics.duration_seconds / 60) : '',
    기존이동거리_km: day.baseline_metrics ? Number((day.baseline_metrics.distance_meters / 1000).toFixed(1)) : '',
  }));
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(summaryRows), '일차 요약');

  // A visit whose address could not be resolved never reaches day.stops. Leaving it out
  // of the workbook would quietly drop a real visit from the plan the user works off.
  const attentionRows = buildAttentionRows(result);
  if (attentionRows.length) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(attentionRows), '확인 필요');
  }

  // The sheet people actually work from: their own rows, untouched, with the plan's
  // columns appended. A detached copy would force them to reconcile two tables by hand.
  if (source) {
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet(buildAnnotatedRows(source, result)),
      `원본+결과_${source.name}`.slice(0, 31),
    );
  }
  XLSX.writeFile(workbook, `Qroad_경로계획_${new Date().toISOString().slice(0, 10)}.xlsx`);
}

const RESULT_COLUMNS = [
  'Qroad_일차',
  'Qroad_방문순서',
  'Qroad_예상도착',
  'Qroad_예상출발',
  'Qroad_이동시간_분',
  'Qroad_이동거리_km',
  'Qroad_체류시간_분',
  'Qroad_확인주소',
  'Qroad_주소확인',
  'Qroad_시간조건',
] as const;

/**
 * Rebuilds the uploaded sheet with the plan appended to each row, matched by the
 * spreadsheet row number the visit came from. Rows the plan never touched keep their
 * original content and simply get blank result cells.
 */
export function buildAnnotatedRows(source: SheetData, result: PlanResponse): unknown[][] {
  const visitById = new Map(result.visits.map((visit) => [visit.id, visit]));
  const planByRow = new Map<number, Record<string, string | number>>();
  result.days.forEach((day) => {
    day.stops.forEach((stop) => {
      const visit = visitById.get(stop.visit_id);
      if (!visit) return;
      planByRow.set(visit.source_row, {
        Qroad_일차: day.day_number,
        Qroad_방문순서: stop.optimized_order,
        Qroad_예상도착: stop.arrival_time ?? '',
        Qroad_예상출발: stop.departure_time ?? '',
        Qroad_이동시간_분: Math.round(stop.travel_seconds_from_previous / 60),
        Qroad_이동거리_km: Number((stop.travel_distance_meters_from_previous / 1000).toFixed(1)),
        Qroad_체류시간_분: stop.service_minutes,
        Qroad_확인주소: stop.address,
        Qroad_주소확인: geocodeLabel(visit),
        Qroad_시간조건: describeTimeConstraint(stop),
      });
    });
  });
  // Visits that never reached a route still deserve a mark on their own row.
  result.visits
    .filter((visit) => visit.geocode_status !== 'matched' && !planByRow.has(visit.source_row))
    .forEach((visit) => planByRow.set(visit.source_row, { Qroad_주소확인: geocodeLabel(visit) }));

  const headerRow = source.headerRowIndex;
  const width = Math.max(...source.rawRows.map((row) => row.length), source.headers.length);
  return source.rawRows.map((row, index) => {
    const padded: unknown[] = Array.from({ length: width }, (_, column) => row[column] ?? '');
    if (index < headerRow) return padded;
    if (index === headerRow) return [...padded, ...RESULT_COLUMNS];
    const plan = planByRow.get(index + 1);
    return [...padded, ...RESULT_COLUMNS.map((column) => plan?.[column] ?? '')];
  });
}

function describeTimeConstraint(stop: PlanResponse['days'][number]['stops'][number]): string {
  if (!stop.time_constraint) return '';
  if (stop.time_constraint.minute_of_day == null) return `${stop.time_constraint.raw} (시각 미인식)`;
  const wording: Record<string, string> = { late: '늦음', early: '이름', shifted: '차이 큼', ok: '충족' };
  return `${stop.time_constraint.description}${stop.time_status ? ` · ${wording[stop.time_status]}` : ''}`;
}

export function buildAttentionRows(result: PlanResponse): Array<Record<string, string | number | undefined>> {
  const issueByVisit = new Map<string, string>();
  result.issues.forEach((issue) => {
    if (issue.visit_id && !issueByVisit.has(issue.visit_id)) issueByVisit.set(issue.visit_id, issue.message);
  });
  return result.visits
    .filter((visit) => visit.geocode_status !== 'matched')
    .map((visit) => ({
      원본행: visit.source_row,
      방문지: visit.label,
      입력주소: visit.address,
      주소확인: geocodeLabel(visit),
      배정일차: visit.optimized_day ?? '',
      후보주소: visit.geocode_candidates.map((candidate) => candidate.address).join(' | '),
      안내: issueByVisit.get(visit.id) ?? '',
    }));
}

function geocodeLabel(visit: PlannedVisit | undefined): string {
  if (!visit) return '';
  if (visit.geocode_status === 'matched') return '주소 검색 일치';
  return visit.geocode_status === 'review' ? '장소명 검색 · 확인 필요' : '주소 미확인';
}

function dayStatusLabel(status: PlanResponse['days'][number]['status']): string {
  if (status === 'optimized') return '도로 시간 기준';
  return status === 'estimated' ? '추정 구간 포함' : '주소 확인 필요';
}
