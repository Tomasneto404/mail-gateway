// Authored by Tomás Neto (TN 2026)
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MinuteBars, fmtMs } from './queues-dialog';

describe('queues dialog helpers', () => {
  it('formats durations for people', () => {
    expect([fmtMs(null), fmtMs(12.4), fmtMs(850), fmtMs(4200), fmtMs(42_000), fmtMs(180_000), fmtMs(5_400_000)]).toEqual([
      '—',
      '12 ms',
      '850 ms',
      '4.2 s',
      '42 s',
      '3 min',
      '1.5 h',
    ]);
  });

  it('draws completed above the axis and failed below, one slot per minute', () => {
    const completed = Array(60).fill(0);
    const failed = Array(60).fill(0);
    completed[58] = 4;
    completed[59] = 2;
    failed[59] = 1;
    const { container } = render(<MinuteBars completed={completed} failed={failed} at={Date.UTC(2026, 10, 23, 12, 0)} />);
    expect(screen.getByRole('img', { name: 'Per minute: 6 completed and 1 failed in the last hour' })).toBeInTheDocument();
    expect(container.querySelectorAll('rect.fill-chart-lead')).toHaveLength(2);
    expect(container.querySelectorAll('rect.fill-chart-neg')).toHaveLength(1);
    expect(container.querySelectorAll('title')).toHaveLength(60);
  });

  it('says so when nothing ran', () => {
    render(<MinuteBars completed={Array(60).fill(0)} failed={Array(60).fill(0)} at={0} />);
    expect(screen.getByRole('img', { name: 'No jobs finished in the last hour' })).toBeInTheDocument();
  });
});
