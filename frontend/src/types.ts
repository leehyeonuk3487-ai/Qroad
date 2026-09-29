export type FieldKey =
  | 'label'
  | 'address'
  | 'addressRegion'
  | 'addressDetail'
  | 'day'
  | 'order'
  | 'serviceMinutes'
  | 'taskCount'
  | 'timeHint';

export type ColumnMapping = Record<FieldKey, string>;

export interface SheetData {
  name: string;
  headerRowIndex: number;
  headers: string[];
  rows: string[][];
  /** 1-based spreadsheet row for each entry of `rows`, kept because blank rows are filtered out. */
  rowNumbers: number[];
  rawRows: unknown[][];
}

export interface ImportedWorkbook {
  filename: string;
  sheets: SheetData[];
}

export interface CanonicalVisit {
  id: string;
  source_row: number;
  label: string;
  address: string;
  original_day?: number;
  original_order?: number;
  service_minutes?: number;
  task_count?: number;
  time_hint?: string;
}

export interface Coordinate {
  longitude: number;
  latitude: number;
}

export interface GeocodeCandidate {
  label: string;
  address: string;
  coordinate: Coordinate;
  source: 'address' | 'keyword';
}

export interface PlannedVisit extends CanonicalVisit {
  normalized_address?: string;
  coordinate?: Coordinate;
  geocode_status: 'matched' | 'review' | 'unmatched';
  geocode_candidates: GeocodeCandidate[];
  optimized_day?: number;
  optimized_order?: number;
  time_constraint?: TimeConstraint | null;
}

export interface RouteMetrics {
  distance_meters: number;
  duration_seconds: number;
}

export interface RouteEndpoint {
  label: string;
  address: string;
  coordinate: Coordinate;
  kind: 'start' | 'end' | 'lodging';
}

export interface TimeConstraint {
  kind: 'at' | 'before' | 'after' | 'vague';
  minute_of_day?: number | null;
  raw: string;
  description: string;
}

export interface RouteStop {
  visit_id: string;
  optimized_order: number;
  label: string;
  address: string;
  arrival_time?: string;
  departure_time?: string;
  travel_seconds_from_previous: number;
  travel_distance_meters_from_previous: number;
  travel_is_estimated: boolean;
  travel_from_start: boolean;
  service_minutes: number;
  task_count?: number | null;
  time_constraint?: TimeConstraint | null;
  time_status?: 'ok' | 'late' | 'early' | 'shifted' | null;
}

export interface DayPlan {
  day_number: number;
  status: 'optimized' | 'estimated' | 'needs_review';
  basis: string;
  stops: RouteStop[];
  optimized_metrics: RouteMetrics;
  baseline_metrics?: RouteMetrics | null;
  polyline: Coordinate[];
  start?: RouteEndpoint | null;
  end?: RouteEndpoint | null;
  /** Visit ids in the order the source file listed them, for the before/after comparison. */
  baseline_order: string[];
  service_minutes_total: number;
  task_count_total?: number | null;
  estimated_leg_count: number;
  review_visit_count: number;
}

export interface PlanIssue {
  kind:
    | 'unmatched_address'
    | 'review_address'
    | 'routing_fallback'
    | 'settings'
    | 'capacity'
    | 'time_constraint';
  severity: 'info' | 'warning' | 'error';
  visit_id?: string;
  source_row?: number;
  message: string;
}

export interface PlanResponse {
  visits: PlannedVisit[];
  days: DayPlan[];
  issues: PlanIssue[];
  matrix_source: 'kakao_road' | 'estimated';
  partition_basis: string;
  optimization_status: 'completed' | 'partial';
}

export interface TripSettings {
  trip_days: number;
  start_address?: string;
  end_address?: string;
  lodging_address?: string;
  departure_time: string;
  default_service_minutes: number;
  minutes_per_task: number;
}

/** Mirrors the backend ceiling in app/models.py, checked before a request is sent. */
export const MAX_VISITS = 200;
