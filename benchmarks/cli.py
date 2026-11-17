#!/usr/bin/env python3
"""Run a disposable subprocess workload: python3 benchmarks/cli.py path/to/ticketd [--tickets N]."""
import argparse
import json
import os
import statistics
import subprocess
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('cli')
parser.add_argument('--tickets', type=int, default=1000, help='tickets to create (default 1000; at least 100)')
options = parser.parse_args()
if options.tickets < 100:
    parser.error('--tickets must be at least 100')
cli = str(Path(options.cli).resolve())


def isolated(directory):
    """Environment whose workspace lives in `directory`. Windows ignores HOME and XDG_DATA_HOME,
    so only TICKETD_TEST_WORKSPACE keeps the run out of the person's real workspace."""
    target_env = dict(os.environ, TICKETD_TEST_WORKSPACE=str(Path(directory) / 'workspace.sqlite3'))
    target_env.pop('TICKETD_CHAT_ID', None)
    target_env.pop('TICKETD_AUTOMATION_RUN_ID', None)
    # `workspace` reports the path without creating or migrating anything: refuse to run when the
    # CLI would open a workspace outside the temporary directory (or cannot say where it is).
    probe = subprocess.run([cli, 'workspace'], text=True, capture_output=True, env=target_env)
    if probe.returncode != 0:
        raise SystemExit(f'refusing to run: `ticketd workspace` failed: {probe.stderr.strip()}')
    reported = json.loads(probe.stdout)['path'].removeprefix('\\\\?\\')
    if not Path(reported).resolve().is_relative_to(Path(directory).resolve()):
        raise SystemExit(f'refusing to run: the CLI resolves its workspace to {reported}, outside {directory}')
    return target_env


with tempfile.TemporaryDirectory() as home:
    env = isolated(home)

    def run(*args, data=None):
        started = time.perf_counter()
        result = subprocess.run([cli, *args], input=json.dumps(data) if data is not None else None,
                                text=True, capture_output=True, env=env, check=True)
        return (time.perf_counter() - started) * 1000, json.loads(result.stdout)

    def report(name, values):
        values = sorted(values)
        print(f'{name}: n={len(values)} median={statistics.median(values):.1f}ms max={max(values):.1f}ms')

    cold, _ = run('list')
    print(f'first workspace open: {cold:.1f}ms')
    isolated(home)  # The workspace now exists: check its resolved path too.
    project = run('project', 'create', 'Benchmark', home)[1]
    batches = []
    for start in range(0, options.tickets, 100):
        operations = [dict(operation='create', name=f't{i}', title=f'Benchmark ticket {i}', project_id=project['id'])
                      for i in range(start, min(start + 100, options.tickets))]
        duration, tickets = run('batch', '-', data=operations)
        batches.append(duration)
    report(f'100-ticket batch ({options.tickets} tickets)', batches)
    # Populate 100 tickets with Markdown, activities and tags, in one bounded batch.
    body = ('## Context\nA concrete implementation outcome with acceptance criteria.\n' * 40)
    changes = [dict(operation='change', ticket=t['reference'], change=dict(body=body, activities=['Investigation finding', 'Verification result'], add_tags=['feature', 'review'])) for t in tickets]
    run('batch', '-', data=changes)
    ref = tickets[-1]['reference']
    run('batch', '-', data=[dict(operation='change', ticket=ref, change=dict(add_blockers=[t['reference'] for t in tickets[:49]]))])
    for label, args in [('list page (first 50)', ('list',)),
                        ('list page (middle 50)', ('list', '--offset', str(options.tickets // 2))),
                        ('project list', ('list', '--project', project['id'])),
                        ('editor read', ('show', ref)),
                        ('context', ('context', ref, '--project', '--relationships', '--activities')),
                        ('graph', ('graph', ref))]:
        report(label, [run(*args)[0] for _ in range(20)])
    # Each keystroke of a typed query is a fresh search.
    query = 'Benchmark ticket 9'
    report(f'search keystroke ("{query}", one search per prefix)',
           [run('search', query[:n])[0] for _ in range(2) for n in range(1, len(query) + 1)])
    report('single write (create)', [run('create', f'Single write {i}')[0] for i in range(20)])
    report('50-change batch', [run('batch', '-', data=[dict(operation='change', ticket=t['reference'], change=dict(title=f'Renamed {round} {t["reference"]}'))
                                                       for t in tickets[:50]])[0] for round in range(10)])
    def worker(i):
        if i % 2:
            return run('list')[0]
        return run('create', f'Concurrent {i}')[0]
    with ThreadPoolExecutor(max_workers=8) as pool:
        report('8 concurrent CLI processes (4 writes / 4 reads per wave)', list(pool.map(worker, range(40))))

    # Race real processes against one another on the same workspace.
    a, b = tickets[0]['reference'], tickets[1]['reference']
    def command(args, payload=None, target_env=env):
        return subprocess.run([cli, *args], input=json.dumps(payload) if payload is not None else None,
                              text=True, capture_output=True, env=target_env)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda pair: command(['add-dependency', *pair]), [(a, b), (b, a)]))
    assert sorted(r.returncode == 0 for r in results) == [False, True]
    request = dict(operation='create_ticket', title='Duplicate request marker', project_id=None)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: command(['write', '-', '--request-id', 'same-request'], request), range(2)))
    assert all(r.returncode == 0 for r in results)
    assert json.loads(results[0].stdout) == json.loads(results[1].stdout)
    assert len(run('search', 'Duplicate request marker')[1]) == 1
    failed = command(['batch', '-'], [dict(operation='create', name='rollback', title='Rollback marker', project_id=None),
                                       dict(operation='change', ticket='T-KQ999999', change=dict(title='invalid'))])
    assert failed.returncode != 0 and not run('search', 'Rollback marker')[1]
    with tempfile.TemporaryDirectory() as fresh:
        fresh_env = isolated(fresh)
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _: command(['list'], target_env=fresh_env), range(8)))
        assert all(r.returncode == 0 and json.loads(r.stdout) == [] for r in results)
    print('Process races passed: opposing dependencies, duplicate request, failed batch rollback, concurrent first opens')
