import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  Download,
  FileSpreadsheet,
  FileUp,
  MapPinned,
  Play,
  RefreshCw,
  Hotel,
  ListOrdered,
  Route,
  RotateCcw,
  ShieldCheck,
  SlidersHorizontal,
  Timer,
} from 'lucide-react';
import MapPanel from './components/MapPanel';
import { requestPlan } from './lib/api';
import { exportPlan } from './lib/export';
import {
  emptyMapping,
  fieldLabels,
  inferMapping,
  normalizeVisits,
  readWorkbook,
  textToSheet,
} from './lib/normalize';
import type {
  CanonicalVisit,
  ColumnMapping,
  DayPlan,
  PlannedVisit,
  RouteStop,
  FieldKey,
  ImportedWorkbook,
  PlanResponse,
  SheetData,
  TripSettings,
} from './types';
import { MAX_VISITS } from './types';

type InputMode = 'file' | 'text';

const initialSettings: TripSettings = {
  trip_days: 3,
  departure_time: '09:00',
  default_service_minutes: 30,
  minutes_per_task: 0,
};

export default function App() {
  const [mode, setMode] = useState<InputMode>('file');
  const [workbook, setWorkbook] = useState<ImportedWorkbook | null>(null);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [manualText, setManualText] = useState('');
  const [mapping, setMapping] = useState<ColumnMapping>(emptyMapping);
  const [overrides, setOverrides] = useState<Record<string, Partial<CanonicalVisit>>>({});
  const [settings, setSettings] = useState<TripSettings>(initialSettings);
  const [result, setResult] = useState<PlanResponse | null>(null);
  const [selectedDay, setSelectedDay] = useState(1);
  const [isPlanning, setIsPlanning] = useState(false);
  const [isStale, setIsStale] = useState(false);
  const [showBaseline, setShowBaseline] = useState(true);
  const [error, setError] = useState('');

  const activeSheet = useMemo<SheetData | null>(() => {
    if (mode === 'text') return manualText.trim() ? textToSheet(manualText) : null;
    return workbook?.sheets[sheetIndex] ?? null;
  }, [manualText, mode, sheetIndex, workbook]);

  const baseVisits = useMemo(
    () => (activeSheet ? normalizeVisits(activeSheet, mapping) : []),
    [activeSheet, mapping],
  );
  const visits = useMemo(
    () => baseVisits.map((visit) => ({ ...visit, ...overrides[visit.id] })),
    [baseVisits, overrides],
  );
  const activeDay = result?.days.find((day) => day.day_number === selectedDay) ?? result?.days[0];
  const overLimit = visits.length > MAX_VISITS;

  /** An edit invalidates the shown plan but must not erase it: the candidate list and the
   *  route the user is comparing against live in that same panel. */
  function markStale() {
    setIsStale(true);
  }

  function discardResult() {
    setResult(null);
    setIsStale(false);
  }

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setError('');
    discardResult();
    try {
      const imported = await readWorkbook(file);
      setWorkbook(imported);
      setSheetIndex(0);
      setMode('file');
      setOverrides({});
      setMapping(inferMapping(imported.sheets[0].headers));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '파일을 읽지 못했습니다.');
    }
  }

  function activateManualInput() {
    setMode('text');
    discardResult();
    setOverrides({});
    setMapping({ ...emptyMapping(), address: '주소' });
  }

  function changeSheet(nextIndex: number) {
    const next = workbook?.sheets[nextIndex];
    if (!next) return;
    setSheetIndex(nextIndex);
    setOverrides({});
    discardResult();
    setMapping(inferMapping(next.headers));
  }

  function updateMapping(field: FieldKey, value: string) {
    setMapping((previous) => ({ ...previous, [field]: value }));
    setOverrides({});
    markStale();
  }

  function updateVisit(id: string, patch: Partial<CanonicalVisit>) {
    setOverrides((previous) => ({ ...previous, [id]: { ...previous[id], ...patch } }));
    markStale();
  }

  async function plan() {
    if (!visits.length) {
      setError('주소로 인식된 방문지가 없습니다. 주소 열을 선택하거나 내용을 수정해 주세요.');
      return;
    }
    if (overLimit) {
      setError(`한 번에 계산할 수 있는 방문지는 ${MAX_VISITS}개까지입니다. 현재 ${visits.length}개가 인식되었습니다. 시트를 나눠서 계산해 주세요.`);
      return;
    }
    setError('');
    setIsPlanning(true);
    try {
      const planned = await requestPlan(visits, settings);
      setResult(planned);
      setIsStale(false);
      setSelectedDay(planned.days[0]?.day_number ?? 1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '경로 계산에 실패했습니다.');
    } finally {
      setIsPlanning(false);
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark"><Route size={22} strokeWidth={2.4} /></div>
          <div>
            <strong>Qroad</strong>
            <span>현장 업무 동선 계획</span>
          </div>
        </div>
        <div className="privacy-inline"><ShieldCheck size={16} /> 원본 파일은 이 브라우저에만 남습니다</div>
      </header>

      <section className="workspace-header">
        <div>
          <p className="eyebrow">출장 계획 작업대</p>
          <h1>방문지를 읽고, 일차와 이동 순서를 계획합니다.</h1>
          <p className="subtitle">주소와 방문 관련 열만 확인한 뒤 경로 계산에 보냅니다. 알 수 없는 정보는 추정하지 않고 표시합니다.</p>
        </div>
        <ol className="workflow" aria-label="작업 단계">
          <li className={activeSheet ? 'done' : 'current'}><span>1</span> 자료 읽기</li>
          <li className={activeSheet ? 'current' : ''}><span>2</span> 정보 확인</li>
          <li className={result ? 'done' : ''}><span>3</span> 경로 결과</li>
        </ol>
      </section>

      {error && <div className="notice error"><AlertTriangle size={18} />{error}</div>}

      <section className="input-area" aria-labelledby="input-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">1. 방문지 불러오기</p>
            <h2 id="input-title">원본 형식에 맞춰 필요한 열만 고릅니다</h2>
          </div>
          {(workbook || manualText) && (
            <button className="icon-text-button subtle" onClick={() => { setWorkbook(null); setManualText(''); discardResult(); }}>
              <RotateCcw size={16} /> 새 자료
            </button>
          )}
        </div>

        <div className="input-mode-tabs" role="tablist" aria-label="입력 방식">
          <button role="tab" aria-selected={mode === 'file'} className={mode === 'file' ? 'active' : ''} onClick={() => setMode('file')}>
            <FileSpreadsheet size={17} /> Excel 또는 CSV
          </button>
          <button role="tab" aria-selected={mode === 'text'} className={mode === 'text' ? 'active' : ''} onClick={activateManualInput}>
            <FileUp size={17} /> 주소 목록 직접 입력
          </button>
        </div>

        {mode === 'file' ? (
          <label className="upload-zone">
            <input type="file" accept=".xlsx,.xls,.csv" onChange={(event) => void handleFile(event.target.files?.[0])} />
            <div className="upload-icon"><FileUp size={26} /></div>
            <strong>{workbook ? workbook.filename : 'Excel 또는 CSV 파일 선택'}</strong>
            <span>파일은 브라우저에서 읽습니다. 서버에는 선택한 방문지 정보만 전달됩니다.</span>
          </label>
        ) : (
          <label className="manual-input">
            <span>주소 목록</span>
            <textarea value={manualText} onChange={(event) => { setManualText(event.target.value); markStale(); }} placeholder={'한 줄에 하나씩 주소를 입력하세요.\n예: 서울특별시 중구 세종대로 110'} rows={6} />
          </label>
        )}
      </section>

      {activeSheet && (
        <>
          <section className="mapping-area" aria-labelledby="mapping-title">
            <div className="section-heading">
              <div>
                <p className="eyebrow">2. 인식 결과 검토</p>
                <h2 id="mapping-title">열 매핑과 방문지 내용을 확인하세요</h2>
              </div>
              {mode === 'file' && workbook && workbook.sheets.length > 1 && (
                <label className="sheet-picker">시트
                  <select value={sheetIndex} onChange={(event) => changeSheet(Number(event.target.value))}>
                    {workbook.sheets.map((sheet, index) => <option key={sheet.name} value={index}>{sheet.name}</option>)}
                  </select>
                </label>
              )}
            </div>
            <p className="privacy-note"><ShieldCheck size={16} /> 아래에서 선택한 방문지명, 주소, 원본 행 번호, 선택한 일정 정보만 경로 API에 전달됩니다. 원본의 다른 열은 전송하지 않습니다.</p>

            <div className="mapping-grid">
              {(Object.keys(fieldLabels) as FieldKey[]).map((field) => (
                <label key={field} className={field === 'address' ? 'required-field' : ''}>
                  <span>{fieldLabels[field]}{field === 'address' && <em>필수</em>}</span>
                  <select value={mapping[field]} onChange={(event) => updateMapping(field, event.target.value)}>
                    <option value="">선택 안 함</option>
                    {activeSheet.headers.map((header) => <option key={header} value={header}>{header}</option>)}
                  </select>
                </label>
              ))}
            </div>

            <div className="review-summary">
              <CheckCircle2 size={18} /> <strong>{visits.length}개</strong> 방문지 인식
              {!mapping.address && !mapping.addressRegion && <span className="warn-text">주소 열을 선택해야 계산할 수 있습니다.</span>}
              {overLimit && <span className="warn-text">한 번에 {MAX_VISITS}개까지 계산할 수 있습니다. 시트를 나눠 주세요.</span>}
            </div>
            <div className="table-wrap preview-table-wrap">
              <table>
                <thead><tr><th>원본 행</th><th>방문지</th><th>주소</th><th>기존 일차</th><th>기존 순서</th><th>체류(분)</th></tr></thead>
                <tbody>
                  {visits.slice(0, 100).map((visit) => (
                    <tr key={visit.id}>
                      <td>{visit.source_row}</td>
                      <td><input aria-label={`${visit.source_row}행 방문지`} value={visit.label} onChange={(event) => updateVisit(visit.id, { label: event.target.value })} /></td>
                      <td><input aria-label={`${visit.source_row}행 주소`} value={visit.address} onChange={(event) => updateVisit(visit.id, { address: event.target.value })} /></td>
                      <td><NumberInput value={visit.original_day} onChange={(value) => updateVisit(visit.id, { original_day: value })} /></td>
                      <td><NumberInput value={visit.original_order} onChange={(value) => updateVisit(visit.id, { original_order: value })} /></td>
                      <td><NumberInput value={visit.service_minutes} onChange={(value) => updateVisit(visit.id, { service_minutes: value })} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {visits.length > 100 && <p className="table-footnote">처음 100개만 표시합니다. 나머지 행도 함께 계산됩니다.</p>}
            </div>
          </section>

          <section className="settings-area" aria-labelledby="settings-title">
            <div className="section-heading">
              <div>
                <p className="eyebrow">3. 출장 조건</p>
                <h2 id="settings-title">최소 입력만으로 시작할 수 있습니다</h2>
              </div>
            </div>
            <div className="settings-grid">
              <label className="required-field"><span><CalendarDays size={16} /> 총 출장일수 <em>필수</em></span><NumberInput value={settings.trip_days} min={1} max={31} onChange={(value) => { setSettings((state) => ({ ...state, trip_days: value ?? 1 })); markStale(); }} /></label>
              <label><span><MapPinned size={16} /> 출발지 주소 <small>선택</small></span><input value={settings.start_address ?? ''} onChange={(event) => { setSettings((state) => ({ ...state, start_address: event.target.value })); markStale(); }} placeholder="예: 기관 청사 주소" /></label>
              <label><span><MapPinned size={16} /> 종료지 주소 <small>선택</small></span><input value={settings.end_address ?? ''} onChange={(event) => { setSettings((state) => ({ ...state, end_address: event.target.value })); markStale(); }} placeholder="없으면 마지막 방문지에서 종료" /></label>
              <label><span><Hotel size={16} /> 숙박지 주소 <small>선택</small></span><input value={settings.lodging_address ?? ''} onChange={(event) => { setSettings((state) => ({ ...state, lodging_address: event.target.value })); markStale(); }} placeholder="입력하면 다음 날 출발지로 사용" disabled={settings.trip_days < 2} /></label>
              <label><span><Timer size={16} /> 출발 시각</span><input type="time" value={settings.departure_time} onChange={(event) => { setSettings((state) => ({ ...state, departure_time: event.target.value })); markStale(); }} /></label>
              <label><span><SlidersHorizontal size={16} /> 기본 체류시간(분)</span><NumberInput value={settings.default_service_minutes} min={0} max={480} onChange={(value) => { setSettings((state) => ({ ...state, default_service_minutes: value ?? 30 })); markStale(); }} /></label>
              <label><span><SlidersHorizontal size={16} /> 업무 1건당 추가(분)</span><NumberInput value={settings.minutes_per_task} min={0} max={240} onChange={(value) => { setSettings((state) => ({ ...state, minutes_per_task: value ?? 0 })); markStale(); }} /></label>
            </div>
            <div className="settings-action">
              <p>일차 정보가 있으면 그대로 유지합니다. 없는 방문지는 좌표 근접성과 일차별 체류시간 합계를 함께 고려해 배정합니다. 업무 건수로 체류시간을 늘리려면 1건당 추가 시간을 직접 지정하세요.</p>
              <button className="primary-button" disabled={isPlanning || !visits.length || overLimit} onClick={() => void plan()}>
                <Play size={18} fill="currentColor" /> {isPlanning ? '주소와 경로를 계산하는 중...' : '경로 계산'}
              </button>
            </div>
          </section>
        </>
      )}

      {result && (
        <section className="results-area" aria-labelledby="results-title">
          <div className="section-heading results-heading">
            <div>
              <p className="eyebrow">4. 경로 결과</p>
              <h2 id="results-title">날짜별 방문 순서와 예상 일정을 확인하세요</h2>
              <p className="result-basis">{result.partition_basis}</p>
            </div>
            <button
              className="icon-text-button export-button"
              disabled={isStale}
              title={isStale ? '입력이 바뀌었습니다. 다시 계산한 뒤 내려받으세요.' : undefined}
              onClick={() => exportPlan(activeSheet, result)}
            >
              <Download size={17} /> 결과 Excel
            </button>
          </div>

          {isStale && (
            <div className="notice warning stale-notice">
              <RefreshCw size={17} />
              <span>입력을 수정했습니다. 아래 결과는 수정 전 기준이므로 다시 계산해 주세요.</span>
              <button className="primary-button compact" disabled={isPlanning || overLimit} onClick={() => void plan()}>
                {isPlanning ? '계산 중...' : '다시 계산'}
              </button>
            </div>
          )}

          <div className="result-status-row">
            <span className={result.matrix_source === 'kakao_road' ? 'status-chip good' : 'status-chip caution'}>{result.matrix_source === 'kakao_road' ? '카카오 도로 시간 기준' : '거리 기반 추정 포함'}</span>
            <span className="status-chip neutral">{result.optimization_status === 'completed' ? '계산 완료' : '확인이 필요한 항목 있음'}</span>
          </div>

          {result.issues.length > 0 && (
            <div className="issues-list">
              {result.issues.map((issue, index) => <div key={`${issue.visit_id ?? 'general'}-${index}`} className={`notice ${issue.severity}`}><AlertTriangle size={17} />{issue.message}</div>)}
            </div>
          )}

          {result.visits.some((visit) => visit.geocode_status !== 'matched' && visit.geocode_candidates.length) && (
            <div className="candidate-review">
              <div><p className="eyebrow">주소 후보 확인</p><h3>자동 선택하지 않은 위치입니다</h3></div>
              {result.visits.filter((visit) => visit.geocode_status !== 'matched' && visit.geocode_candidates.length).map((visit) => (
                <div className="candidate-row" key={visit.id}>
                  <strong>원본 행 {visit.source_row} · {visit.label}</strong>
                  <div>
                    {visit.geocode_candidates.map((candidate) => (
                      <button key={`${candidate.address}-${candidate.label}`} onClick={() => updateVisit(visit.id, { address: candidate.address })}>
                        {candidate.address}<ChevronRight size={14} />
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              <p>후보를 선택하면 입력 주소가 바뀝니다. 다시 경로를 계산해 위치를 확인하세요.</p>
            </div>
          )}

          {result.days.some((day) => day.baseline_order.length) && (
            <label className="baseline-toggle">
              <input type="checkbox" checked={showBaseline} onChange={(event) => setShowBaseline(event.target.checked)} />
              <ListOrdered size={15} /> 기존 순서와 비교해서 보기
            </label>
          )}

          <div className="day-tabs" role="tablist" aria-label="일차 선택">
            {result.days.map((day) => <button key={day.day_number} role="tab" aria-selected={activeDay?.day_number === day.day_number} className={activeDay?.day_number === day.day_number ? 'active' : ''} onClick={() => setSelectedDay(day.day_number)}>{day.day_number}일차 <span>{day.stops.length}</span></button>)}
          </div>

          {activeDay && (
            <div className="result-grid">
              <div className="route-panel">
                <Metrics day={activeDay} />
                <DayWorkload day={activeDay} />
                {showBaseline && <SequenceComparison day={activeDay} visits={result.visits} />}
                <div className="route-list">
                  {activeDay.start && <div className="route-endpoint"><MapPinned size={16} /><span>출발</span><strong>{activeDay.start.address}</strong></div>}
                  {activeDay.stops.length ? activeDay.stops.map((stop, index) => (
                    <div className="route-stop" key={stop.visit_id}>
                      <div className="route-order">{stop.optimized_order}</div>
                      <div className="stop-details">
                        <strong>{stop.label}<TimeBadge stop={stop} /></strong>
                        <span>{stop.address}</span>
                        {(index > 0 || stop.travel_from_start) && (
                          <small>
                            {stop.travel_from_start ? '출발지에서' : '이전 방문지에서'} {formatDuration(stop.travel_seconds_from_previous)} · {formatDistance(stop.travel_distance_meters_from_previous)}
                            {stop.travel_is_estimated && <span className="estimate-tag">추정</span>}
                          </small>
                        )}
                      </div>
                      <div className="stop-time"><b>{stop.arrival_time}</b><span>~ {stop.departure_time}</span></div>
                    </div>
                  )) : <div className="empty-route">이 일차에 배정된 방문지가 없습니다.</div>}
                  {activeDay.end && <div className="route-endpoint"><MapPinned size={16} /><span>종료</span><strong>{activeDay.end.address}</strong></div>}
                </div>
              </div>
              <MapPanel day={activeDay} visits={result.visits} showBaseline={showBaseline} />
            </div>
          )}
        </section>
      )}
    </main>
  );
}

function NumberInput({ value, onChange, min, max }: { value?: number; onChange: (value: number | undefined) => void; min?: number; max?: number }) {
  return <input type="number" min={min} max={max} value={value ?? ''} onChange={(event) => onChange(event.target.value === '' ? undefined : Number(event.target.value))} />;
}

function SequenceComparison({ day, visits }: { day: DayPlan; visits: PlannedVisit[] }) {
  if (!day.baseline_order.length || day.stops.length < 2) return null;
  const nameOf = new Map(visits.map((visit) => [visit.id, visit.label]));
  const optimizedIds = day.stops.map((stop) => stop.visit_id);
  const unchanged = day.baseline_order.every((id, index) => optimizedIds[index] === id);
  return (
    <div className="sequence-compare">
      <div className="sequence-row">
        <span className="sequence-tag">기존</span>
        <ol>{day.baseline_order.map((id, index) => <li key={`${id}-${index}`}>{nameOf.get(id) ?? id}</li>)}</ol>
      </div>
      <div className="sequence-row optimized">
        <span className="sequence-tag">계획</span>
        <ol>
          {optimizedIds.map((id, index) => (
            <li key={`${id}-${index}`} className={day.baseline_order[index] === id ? '' : 'moved'}>
              {nameOf.get(id) ?? id}
            </li>
          ))}
        </ol>
      </div>
      {unchanged && <p className="sequence-note">기존 순서가 이미 계산 결과와 같습니다.</p>}
    </div>
  );
}

function TimeBadge({ stop }: { stop: RouteStop }) {
  if (!stop.time_constraint) return null;
  const { time_constraint: constraint, time_status: status } = stop;
  if (constraint.minute_of_day == null) {
    return <span className="time-badge vague" title="정확한 시각이 아니어서 일정 계산에 사용하지 않았습니다">{constraint.raw}</span>;
  }
  const wording: Record<string, string> = { late: '늦음', early: '이름', shifted: '차이 큼', ok: '조건 충족' };
  const tone = status && status !== 'ok' ? 'warn' : 'ok';
  return (
    <span className={`time-badge ${tone}`} title={constraint.raw}>
      {constraint.description}{status ? ` · ${wording[status]}` : ''}
    </span>
  );
}

function DayWorkload({ day }: { day: DayPlan }) {
  if (!day.stops.length) return null;
  return (
    <p className="day-workload">
      체류 합계 <strong>{formatDuration(day.service_minutes_total * 60)}</strong>
      {day.task_count_total != null && <> · 업무 <strong>{day.task_count_total}건</strong></>}
      {day.estimated_leg_count > 0 && <> · 추정 구간 <strong>{day.estimated_leg_count}개</strong></>}
      {day.review_visit_count > 0 && <> · 위치 확인 필요 <strong>{day.review_visit_count}곳</strong></>}
    </p>
  );
}

function Metrics({ day }: { day: DayPlan }) {
  const baseline = day.baseline_metrics;
  return (
    <div className="metrics">
      <div><span>계획 이동시간</span><strong>{formatDuration(day.optimized_metrics.duration_seconds)}</strong><small>{formatDistance(day.optimized_metrics.distance_meters)}</small></div>
      {baseline && <><ArrowRight size={18} /><div className="baseline"><span>기존 경로</span><strong>{formatDuration(baseline.duration_seconds)}</strong><small>{formatDistance(baseline.distance_meters)}</small></div></>}
      {baseline && <div className="improvement"><span>이동시간 변화</span><strong>{formatChange(baseline.duration_seconds - day.optimized_metrics.duration_seconds)}</strong></div>}
    </div>
  );
}

function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}분`;
  return `${Math.floor(minutes / 60)}시간 ${minutes % 60}분`;
}

function formatDistance(meters: number): string {
  return `${(meters / 1000).toFixed(1)}km`;
}

function formatChange(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  return minutes > 0 ? `${minutes}분 단축` : minutes < 0 ? `${Math.abs(minutes)}분 증가` : '변화 없음';
}
