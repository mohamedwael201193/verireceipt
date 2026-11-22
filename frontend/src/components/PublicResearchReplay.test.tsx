import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PublicResearchReplay from './PublicResearchReplay';
import { verifyPublishedSource } from '../lib/browserReplay';
vi.mock('../lib/browserReplay', () => ({ verifyPublishedSource: vi.fn() }));
afterEach(() => vi.resetAllMocks());
describe('public read-only source verification controls', () => {
  it('makes no request until explicitly clicked, then renders only computed fields', async () => {
    vi.mocked(verifyPublishedSource).mockResolvedValue({ checkedAt: '2026-11-22T00:00:00Z', count: 3, bytes: 162971, digest: 'a'.repeat(64), accessions: ['real-accession-from-verifier'] });
    render(<PublicResearchReplay />); expect(verifyPublishedSource).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Verify real stored evidence' }));
    expect(await screen.findByText('PASS: stored-source check only')).toBeInTheDocument();
    expect(screen.getByText('real-accession-from-verifier')).toBeInTheDocument(); expect(screen.getByText(/not the full 33-check CLI/)).toBeInTheDocument();
  });
  it('HOLD never leaves a stale pass/count after a subsequent failure', async () => {
    vi.mocked(verifyPublishedSource).mockResolvedValueOnce({ checkedAt: '2026-11-22T00:00:00Z', count: 3, bytes: 162971, digest: 'a'.repeat(64), accessions: [] }).mockRejectedValueOnce(new Error('unavailable'));
    render(<PublicResearchReplay />); fireEvent.click(screen.getByRole('button', { name: 'Verify real stored evidence' }));
    await screen.findByText('PASS: stored-source check only'); fireEvent.click(screen.getByRole('button', { name: 'Verify real stored evidence' }));
    expect(await screen.findByRole('status')).toHaveTextContent('HOLD'); expect(screen.queryByText('PASS: stored-source check only')).not.toBeInTheDocument();
  });
  it('cancel aborts the actual verifier and restores the control', async () => {
    let seen: AbortSignal | undefined;
    vi.mocked(verifyPublishedSource).mockImplementation(signal => { seen = signal; return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')))); });
    render(<PublicResearchReplay />); fireEvent.click(screen.getByRole('button', { name: 'Verify real stored evidence' }));
    expect(screen.getByRole('button', { name: 'Checking public evidence…' })).toBeDisabled(); fireEvent.click(screen.getByRole('button', { name: 'Cancel verification' }));
    expect(seen?.aborted).toBe(true); await waitFor(() => expect(screen.getByRole('button', { name: 'Verify real stored evidence' })).toBeEnabled()); expect(screen.getByRole('status')).toHaveTextContent('HOLD');
  });
  it('unmount aborts and cannot populate a later page', () => {
    let seen: AbortSignal | undefined; vi.mocked(verifyPublishedSource).mockImplementation(signal => { seen = signal; return new Promise(() => {}); });
    const { unmount } = render(<PublicResearchReplay />); fireEvent.click(screen.getByRole('button', { name: 'Verify real stored evidence' })); unmount(); expect(seen?.aborted).toBe(true);
  });
});
