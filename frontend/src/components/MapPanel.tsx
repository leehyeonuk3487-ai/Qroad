import { useEffect, useMemo, useRef, useState } from 'react';
import { MapPinned } from 'lucide-react';
import type { Coordinate, DayPlan, PlannedVisit } from '../types';

declare global {
  interface Window {
    kakao?: {
      maps: {
        load: (callback: () => void) => void;
        Map: new (node: HTMLElement, options: object) => {
          setBounds: (bounds: unknown) => void;
          relayout: () => void;
        };
        LatLng: new (latitude: number, longitude: number) => unknown;
        LatLngBounds: new () => { extend: (position: unknown) => void };
        Marker: new (options: object) => { setMap: (map: unknown) => void };
        MarkerImage: new (source: string, size: unknown, options?: object) => unknown;
        Size: new (width: number, height: number) => unknown;
        Point: new (x: number, y: number) => unknown;
        Polyline: new (options: object) => { setMap: (map: unknown) => void };
      };
    };
  }
}

interface MapPanelProps {
  day: DayPlan | undefined;
  visits: PlannedVisit[];
  showBaseline?: boolean;
}

type KakaoMap = { setBounds: (bounds: unknown) => void; relayout: () => void };

const kakaoMapKey = import.meta.env.VITE_KAKAO_MAP_KEY as string | undefined;

interface Overlay {
  setMap: (map: unknown) => void;
}

export default function MapPanel({ day, visits, showBaseline = false }: MapPanelProps) {
  const node = useRef<HTMLDivElement>(null);
  const mapRef = useRef<KakaoMap | null>(null);
  const overlaysRef = useRef<Overlay[]>([]);
  const [mapReady, setMapReady] = useState(false);
  const points = useMemo(() => dayPoints(day, visits), [day, visits]);
  const polyline = day?.polyline;
  const baseline = useMemo(
    () => (showBaseline ? baselinePath(day, visits) : []),
    [day, visits, showBaseline],
  );

  useEffect(() => {
    if (!kakaoMapKey || !node.current || !points.length) return;
    let cancelled = false;
    loadKakaoMaps(kakaoMapKey).then(() => {
      if (cancelled || !node.current || !window.kakao) return;
      const maps = window.kakao.maps;
      const first = points[0];
      // Switching days reuses one map. Constructing a new one over the same node each
      // time leaves the previous day's markers and route line drawn on top.
      if (!mapRef.current) {
        mapRef.current = new maps.Map(node.current, {
          center: new maps.LatLng(first.coordinate.latitude, first.coordinate.longitude),
          level: 8,
        });
      }
      const map = mapRef.current;
      overlaysRef.current.forEach((overlay) => overlay.setMap(null));
      overlaysRef.current = [];

      const bounds = new maps.LatLngBounds();
      points.forEach((point) => {
        const position = new maps.LatLng(point.coordinate.latitude, point.coordinate.longitude);
        bounds.extend(position);
        const marker = new maps.Marker({
          position,
          title: `${point.marker}. ${point.label}`,
          image: new maps.MarkerImage(
            markerSvg(point.marker),
            new maps.Size(30, 38),
            { offset: new maps.Point(15, 38) },
          ),
        });
        marker.setMap(map);
        overlaysRef.current.push(marker);
      });
      // The original sequence is drawn first and dashed, so the solid planned route reads
      // on top of it and the two can be compared at a glance.
      if (baseline.length > 1) {
        const original = new maps.Polyline({
          path: baseline.map((point) => new maps.LatLng(point.latitude, point.longitude)),
          strokeWeight: 4,
          strokeColor: '#c2703a',
          strokeOpacity: 0.85,
          strokeStyle: 'shortdash',
        });
        original.setMap(map);
        overlaysRef.current.push(original);
        baseline.forEach((point) => bounds.extend(new maps.LatLng(point.latitude, point.longitude)));
      }
      const line = polyline?.length ? polyline : points.map((point) => point.coordinate);
      if (line.length > 1) {
        const route = new maps.Polyline({
          path: line.map((point) => new maps.LatLng(point.latitude, point.longitude)),
          strokeWeight: 5,
          strokeColor: '#0e8b78',
          strokeOpacity: 0.9,
          strokeStyle: 'solid',
        });
        route.setMap(map);
        overlaysRef.current.push(route);
      }
      map.relayout();
      map.setBounds(bounds);
      setMapReady(true);
    }).catch(() => setMapReady(false));
    return () => {
      cancelled = true;
    };
  }, [points, polyline, baseline]);

  useEffect(
    () => () => {
      overlaysRef.current.forEach((overlay) => overlay.setMap(null));
      overlaysRef.current = [];
      mapRef.current = null;
    },
    [],
  );

  if (!day || !points.length) {
    return <div className="empty-map"><MapPinned size={22} /> 계산된 방문 좌표가 여기에 표시됩니다.</div>;
  }

  return (
    <div className="map-shell" aria-label={`${day.day_number}일차 방문 경로 지도`}>
      {kakaoMapKey ? <div ref={node} className="kakao-map" /> : <CoordinatePreview points={points} baseline={baseline} />}
      <div className="map-caption">
        <MapPinned size={15} />
        {kakaoMapKey && mapReady
          ? day.polyline.length ? '카카오 도로 경로' : '방문 순서 연결선 (도로 경로 없음)'
          : '좌표 미리보기: VITE_KAKAO_MAP_KEY 설정 시 지도 전환'}
        {baseline.length > 1 && <em className="legend-baseline">점선: 기존 순서</em>}
      </div>
    </div>
  );
}

interface MapPoint {
  key: string;
  order: number;
  marker: string;
  label: string;
  coordinate: Coordinate;
}

function dayPoints(day: DayPlan | undefined, visits: PlannedVisit[]): MapPoint[] {
  if (!day) return [];
  const visitById = new Map(visits.map((visit) => [visit.id, visit]));
  const stops = day.stops.flatMap((stop) => {
    const visit = visitById.get(stop.visit_id);
    return visit?.coordinate ? [{ key: stop.visit_id, order: stop.optimized_order, marker: String(stop.optimized_order), label: stop.label, coordinate: visit.coordinate }] : [];
  });
  return [
    ...(day.start ? [{ key: 'start', order: 0, marker: '출', label: day.start.label, coordinate: day.start.coordinate }] : []),
    ...stops,
    ...(day.end ? [{ key: 'end', order: Number.MAX_SAFE_INTEGER, marker: '종', label: day.end.label, coordinate: day.end.coordinate }] : []),
  ];
}

/** The source file's visit order, as coordinates, for the dashed comparison line. */
function baselinePath(day: DayPlan | undefined, visits: PlannedVisit[]): Coordinate[] {
  if (!day?.baseline_order.length) return [];
  const coordinateOf = new Map(visits.map((visit) => [visit.id, visit.coordinate]));
  const stops = day.baseline_order.flatMap((id) => {
    const coordinate = coordinateOf.get(id);
    return coordinate ? [coordinate] : [];
  });
  if (stops.length < 2) return [];
  return [
    ...(day.start ? [day.start.coordinate] : []),
    ...stops,
    ...(day.end ? [day.end.coordinate] : []),
  ];
}

function CoordinatePreview({ points, baseline }: { points: MapPoint[]; baseline: Coordinate[] }) {
  const positions = project(points);
  const baselinePositions = projectAgainst(baseline, points);
  return (
    <div className="coordinate-map" role="img" aria-label="방문지 좌표 순서 미리보기">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        {baselinePositions.length > 1 && (
          <polyline className="baseline-line" points={baselinePositions.map((point) => `${point.x},${point.y}`).join(' ')} />
        )}
        <polyline points={positions.map((point) => `${point.x},${point.y}`).join(' ')} />
      </svg>
      {positions.map((point) => (
        <div key={point.key} className="coordinate-pin" style={{ left: `${point.x}%`, top: `${point.y}%` }} title={point.label}>
          {point.marker}
        </div>
      ))}
    </div>
  );
}

/** Places arbitrary coordinates on the same scale the markers already use. */
function projectAgainst(coordinates: Coordinate[], reference: MapPoint[]): Array<{ x: number; y: number }> {
  if (coordinates.length < 2 || !reference.length) return [];
  const bounds = extent(reference.map((point) => point.coordinate).concat(coordinates));
  return coordinates.map((coordinate) => ({
    x: 8 + ((coordinate.longitude - bounds.minLongitude) / bounds.longitudeRange) * 84,
    y: 92 - ((coordinate.latitude - bounds.minLatitude) / bounds.latitudeRange) * 84,
  }));
}

function extent(coordinates: Coordinate[]) {
  const longitudes = coordinates.map((coordinate) => coordinate.longitude);
  const latitudes = coordinates.map((coordinate) => coordinate.latitude);
  const minLongitude = Math.min(...longitudes);
  const minLatitude = Math.min(...latitudes);
  return {
    minLongitude,
    minLatitude,
    longitudeRange: Math.max(Math.max(...longitudes) - minLongitude, 0.01),
    latitudeRange: Math.max(Math.max(...latitudes) - minLatitude, 0.01),
  };
}

function project(points: MapPoint[]): Array<MapPoint & { x: number; y: number }> {
  const longitudes = points.map((point) => point.coordinate.longitude);
  const latitudes = points.map((point) => point.coordinate.latitude);
  const minLongitude = Math.min(...longitudes);
  const minLatitude = Math.min(...latitudes);
  const longitudeRange = Math.max(Math.max(...longitudes) - minLongitude, 0.01);
  const latitudeRange = Math.max(Math.max(...latitudes) - minLatitude, 0.01);
  return points.map((point) => ({
    ...point,
    x: 8 + ((point.coordinate.longitude - minLongitude) / longitudeRange) * 84,
    y: 92 - ((point.coordinate.latitude - minLatitude) / latitudeRange) * 84,
  }));
}

function loadKakaoMaps(key: string): Promise<void> {
  if (window.kakao?.maps) return Promise.resolve();
  const existing = document.getElementById('kakao-map-sdk') as HTMLScriptElement | null;
  if (existing) return new Promise((resolve, reject) => {
    existing.addEventListener('load', () => window.kakao?.maps.load(resolve), { once: true });
    existing.addEventListener('error', reject, { once: true });
  });
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.id = 'kakao-map-sdk';
    script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(key)}&autoload=false`;
    script.async = true;
    script.onload = () => window.kakao?.maps.load(resolve);
    script.onerror = () => reject(new Error('Kakao map SDK could not load'));
    document.head.appendChild(script);
  });
}

function markerSvg(marker: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="38" viewBox="0 0 30 38"><path fill="#0e8b78" d="M15 0C7.3 0 1 6.2 1 14c0 10.5 14 24 14 24s14-13.5 14-24C29 6.2 22.7 0 15 0Z"/><circle cx="15" cy="14" r="10" fill="white"/><text x="15" y="18" font-size="11" font-family="Arial" text-anchor="middle" fill="#0e8b78" font-weight="700">${marker}</text></svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}
