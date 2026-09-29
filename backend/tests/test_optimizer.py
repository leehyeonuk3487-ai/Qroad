from app.analysis.optimizer import calculate_metrics, optimize_path


def test_optimizer_visits_every_location_once_with_fixed_endpoints() -> None:
    # Nodes 0-2 are visits; 3 and 4 are the fixed start and end respectively.
    durations = [
        [0, 80, 35, 25, 95],
        [80, 0, 30, 90, 20],
        [35, 30, 0, 55, 45],
        [25, 90, 55, 0, 100],
        [95, 20, 45, 100, 0],
    ]
    distances = [[value * 10 for value in row] for row in durations]

    ordered = optimize_path([0, 1, 2], durations, start_index=3, end_index=4)
    metrics = calculate_metrics(ordered, durations, distances, start_index=3, end_index=4)

    assert set(ordered) == {0, 1, 2}
    assert len(ordered) == 3
    assert metrics.duration_seconds > 0
    assert metrics.distance_meters == metrics.duration_seconds * 10
