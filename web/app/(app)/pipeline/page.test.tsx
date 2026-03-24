import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  PipelineMonitorStatus,
  PipelineTrackList,
  PipelineTrack,
  AcquisitionStatus,
} from "@/lib/api";

/* ── Mocks ──────────────────────────────────────────────────────── */

const mockFetchStatus = vi.fn();
const mockFetchTracks = vi.fn();
const mockBulkAction = vi.fn();
const mockBulkCreateJobs = vi.fn();
const mockRetryTrack = vi.fn();
const mockFetchTrackJobs = vi.fn();

vi.mock("@/lib/api", () => ({
  fetchPipelineMonitorStatus: (...args: unknown[]) => mockFetchStatus(...args),
  fetchPipelineTracks: (...args: unknown[]) => mockFetchTracks(...args),
  bulkPipelineAction: (...args: unknown[]) => mockBulkAction(...args),
  bulkCreateJobs: (...args: unknown[]) => mockBulkCreateJobs(...args),
  retryPipelineTrack: (...args: unknown[]) => mockRetryTrack(...args),
  fetchTrackJobs: (...args: unknown[]) => mockFetchTrackJobs(...args),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { getSession: () => Promise.resolve({ data: { session: null } }) },
    channel: () => ({ on: () => ({ subscribe: () => {} }), subscribe: () => {} }),
    removeChannel: () => {},
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

/* ── Helpers ────────────────────────────────────────────────────── */

function makeTrack(overrides: Partial<PipelineTrack> & { id: number }): PipelineTrack {
  return {
    title: `Track ${overrides.id}`,
    artist: `Artist ${overrides.id}`,
    album: null,
    artwork_url: null,
    acquisition_status: "candidate",
    search_string: null,
    search_results_count: null,
    source: null,
    created_at: "2026-03-24T00:00:00Z",
    updated_at: "2026-03-24T00:00:00Z",
    ...overrides,
  };
}

function makeStatus(overrides: Partial<PipelineMonitorStatus> = {}): PipelineMonitorStatus {
  return {
    candidate: 0,
    searching: 0,
    found: 0,
    not_found: 0,
    queued: 0,
    downloading: 0,
    failed: 0,
    paused: 0,
    agents: [],
    ...overrides,
  };
}

function makeTrackList(tracks: PipelineTrack[]): PipelineTrackList {
  return { tracks, total: tracks.length, page: 1, per_page: 25 };
}

function setupMocks(
  tracks: PipelineTrack[],
  statusOverrides: Partial<PipelineMonitorStatus> = {},
) {
  mockFetchStatus.mockResolvedValue(makeStatus(statusOverrides));
  mockFetchTracks.mockResolvedValue(makeTrackList(tracks));
  mockBulkAction.mockResolvedValue({ updated: 1 });
  mockBulkCreateJobs.mockResolvedValue({ created: 1 });
}

/** Get the selection action bar (blue background bar with "N selected" text) */
function getSelectionBar() {
  const selectedLabel = screen.getByText(/\d+ selected/);
  return selectedLabel.closest("div")!;
}

/** Click the checkbox in a track row by track title */
async function selectTrackByTitle(user: ReturnType<typeof userEvent.setup>, title: string) {
  const row = screen.getByText(title).closest("[class*='grid']")!;
  const checkbox = within(row as HTMLElement).getByRole("checkbox");
  await user.click(checkbox);
}

/* ── Import component (after mocks) ────────────────────────────── */

let PipelineMonitorPage: () => React.JSX.Element;

beforeEach(async () => {
  vi.clearAllMocks();
  // Dynamic import to pick up mocks
  const mod = await import("./page");
  PipelineMonitorPage = mod.default;
});

/* ── Tests ──────────────────────────────────────────────────────── */

describe("Pipeline selection action bar", () => {
  describe("button visibility based on selected statuses", () => {
    it("shows Queue and Pause buttons when candidates are selected", async () => {
      const tracks = [
        makeTrack({ id: 1, acquisition_status: "candidate" }),
        makeTrack({ id: 2, acquisition_status: "candidate" }),
      ];
      setupMocks(tracks, { candidate: 2 });
      const user = userEvent.setup();

      render(<PipelineMonitorPage />);
      await screen.findByText("Track 1");

      await selectTrackByTitle(user, "Track 1");

      const bar = getSelectionBar();
      expect(within(bar).getByText("1 selected")).toBeInTheDocument();
      expect(within(bar).getByText(/Queue 1 Candidate/)).toBeInTheDocument();
      expect(within(bar).getByText(/Pause 1 Candidate/)).toBeInTheDocument();
    });

    it("shows Resume button when paused tracks are selected", async () => {
      const tracks = [
        makeTrack({ id: 1, acquisition_status: "paused" }),
      ];
      setupMocks(tracks, { paused: 1 });
      const user = userEvent.setup();

      render(<PipelineMonitorPage />);
      await screen.findByText("Track 1");

      await selectTrackByTitle(user, "Track 1");

      const bar = getSelectionBar();
      expect(within(bar).getByText(/Resume 1 Paused/)).toBeInTheDocument();
    });

    it("shows Retry button when failed tracks are selected", async () => {
      const tracks = [
        makeTrack({ id: 1, acquisition_status: "failed" }),
        makeTrack({ id: 2, acquisition_status: "not_found" }),
      ];
      setupMocks(tracks, { failed: 1, not_found: 1 });
      const user = userEvent.setup();

      render(<PipelineMonitorPage />);
      await screen.findByText("Track 1");

      // Select both
      await selectTrackByTitle(user, "Track 1");
      await selectTrackByTitle(user, "Track 2");

      const bar = getSelectionBar();
      expect(within(bar).getByText(/Retry 2 Failed/)).toBeInTheDocument();
    });

    it("shows Cancel button for any deletable selection", async () => {
      const tracks = [
        makeTrack({ id: 1, acquisition_status: "candidate" }),
        makeTrack({ id: 2, acquisition_status: "paused" }),
        makeTrack({ id: 3, acquisition_status: "failed" }),
      ];
      setupMocks(tracks, { candidate: 1, paused: 1, failed: 1 });
      const user = userEvent.setup();

      render(<PipelineMonitorPage />);
      await screen.findByText("Track 1");

      await selectTrackByTitle(user, "Track 1");
      await selectTrackByTitle(user, "Track 2");
      await selectTrackByTitle(user, "Track 3");

      const bar = getSelectionBar();
      expect(within(bar).getByText(/Cancel 3 Tracks/)).toBeInTheDocument();
    });

    it("shows all relevant buttons for mixed-status selection", async () => {
      const tracks = [
        makeTrack({ id: 1, acquisition_status: "candidate" }),
        makeTrack({ id: 2, acquisition_status: "paused" }),
        makeTrack({ id: 3, acquisition_status: "failed" }),
      ];
      setupMocks(tracks, { candidate: 1, paused: 1, failed: 1 });
      const user = userEvent.setup();

      render(<PipelineMonitorPage />);
      await screen.findByText("Track 1");

      await selectTrackByTitle(user, "Track 1");
      await selectTrackByTitle(user, "Track 2");
      await selectTrackByTitle(user, "Track 3");

      const bar = getSelectionBar();
      expect(within(bar).getByText(/Queue 1 Candidate/)).toBeInTheDocument();
      expect(within(bar).getByText(/Pause 1 Candidate/)).toBeInTheDocument();
      expect(within(bar).getByText(/Resume 1 Paused/)).toBeInTheDocument();
      expect(within(bar).getByText(/Retry 1 Failed/)).toBeInTheDocument();
      expect(within(bar).getByText(/Cancel 3 Tracks/)).toBeInTheDocument();
    });

    it("does not show selection bar when nothing is selected", async () => {
      const tracks = [
        makeTrack({ id: 1, acquisition_status: "candidate" }),
      ];
      setupMocks(tracks, { candidate: 1 });

      render(<PipelineMonitorPage />);
      await screen.findByText("Track 1");

      expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
    });

    it("hides non-applicable buttons (no Queue for paused-only selection)", async () => {
      const tracks = [
        makeTrack({ id: 1, acquisition_status: "paused" }),
      ];
      setupMocks(tracks, { paused: 1 });
      const user = userEvent.setup();

      render(<PipelineMonitorPage />);
      await screen.findByText("Track 1");

      await selectTrackByTitle(user, "Track 1");

      const bar = getSelectionBar();
      expect(within(bar).queryByText(/Queue \d+ Candidate/)).not.toBeInTheDocument();
      expect(within(bar).queryByText(/Pause \d+ Candidate/)).not.toBeInTheDocument();
    });
  });

  describe("confirmation dialogs", () => {
    it("shows Queue confirmation dialog with correct count", async () => {
      const tracks = [
        makeTrack({ id: 1, acquisition_status: "candidate" }),
        makeTrack({ id: 2, acquisition_status: "candidate" }),
      ];
      setupMocks(tracks, { candidate: 2 });
      const user = userEvent.setup();

      render(<PipelineMonitorPage />);
      await screen.findByText("Track 1");

      await selectTrackByTitle(user, "Track 1");
      await selectTrackByTitle(user, "Track 2");

      await user.click(screen.getByText(/Queue 2 Candidates/));

      expect(screen.getByText("Queue Selected Candidates")).toBeInTheDocument();
      expect(screen.getByText(/Create download jobs for 2 selected candidates/)).toBeInTheDocument();
    });

    it("shows Pause confirmation dialog with correct count", async () => {
      const tracks = [
        makeTrack({ id: 1, acquisition_status: "candidate" }),
      ];
      setupMocks(tracks, { candidate: 1 });
      const user = userEvent.setup();

      render(<PipelineMonitorPage />);
      await screen.findByText("Track 1");

      await selectTrackByTitle(user, "Track 1");
      await user.click(screen.getByText(/Pause 1 Candidate/));

      expect(screen.getByText("Pause Selected Candidates")).toBeInTheDocument();
      expect(screen.getByText(/Pause 1 selected candidate\?/)).toBeInTheDocument();
    });

    it("shows Cancel confirmation dialog with correct count", async () => {
      const tracks = [
        makeTrack({ id: 1, acquisition_status: "candidate" }),
        makeTrack({ id: 2, acquisition_status: "paused" }),
      ];
      setupMocks(tracks, { candidate: 1, paused: 1 });
      const user = userEvent.setup();

      render(<PipelineMonitorPage />);
      await screen.findByText("Track 1");

      await selectTrackByTitle(user, "Track 1");
      await selectTrackByTitle(user, "Track 2");
      await user.click(screen.getByText(/Cancel 2 Tracks/));

      expect(screen.getByText("Cancel Selected Tracks")).toBeInTheDocument();
      expect(screen.getByText(/Permanently delete 2 selected tracks/)).toBeInTheDocument();
    });

    it("dismisses dialog when Cancel button is clicked", async () => {
      const tracks = [
        makeTrack({ id: 1, acquisition_status: "candidate" }),
      ];
      setupMocks(tracks, { candidate: 1 });
      const user = userEvent.setup();

      render(<PipelineMonitorPage />);
      await screen.findByText("Track 1");

      await selectTrackByTitle(user, "Track 1");
      await user.click(screen.getByText(/Pause 1 Candidate/));

      expect(screen.getByText("Pause Selected Candidates")).toBeInTheDocument();

      // Click the Cancel button in the dialog
      const dialog = screen.getByText("Pause Selected Candidates").closest("div[style]")!;
      const cancelBtn = within(dialog as HTMLElement).getByText("Cancel");
      await user.click(cancelBtn);

      expect(screen.queryByText("Pause Selected Candidates")).not.toBeInTheDocument();
    });
  });

  describe("bulk action execution", () => {
    it("calls bulkCreateJobs with selected IDs when Queue is confirmed", async () => {
      const tracks = [
        makeTrack({ id: 10, acquisition_status: "candidate" }),
        makeTrack({ id: 20, acquisition_status: "candidate" }),
      ];
      setupMocks(tracks, { candidate: 2 });
      const user = userEvent.setup();

      render(<PipelineMonitorPage />);
      await screen.findByText("Track 10");

      await selectTrackByTitle(user, "Track 10");
      await selectTrackByTitle(user, "Track 20");
      await user.click(screen.getByText(/Queue 2 Candidates/));

      // Click the confirm button in dialog (scoped to avoid per-row Queue buttons)
      const dialog = screen.getByText("Queue Selected Candidates").closest("div[style]")!;
      await user.click(within(dialog as HTMLElement).getByRole("button", { name: "Queue" }));

      expect(mockBulkCreateJobs).toHaveBeenCalledWith([10, 20]);
    });

    it("calls bulkPipelineAction('pause_candidates', ids) when Pause is confirmed", async () => {
      const tracks = [
        makeTrack({ id: 5, acquisition_status: "candidate" }),
      ];
      setupMocks(tracks, { candidate: 1 });
      const user = userEvent.setup();

      render(<PipelineMonitorPage />);
      await screen.findByText("Track 5");

      await selectTrackByTitle(user, "Track 5");
      await user.click(screen.getByText(/Pause 1 Candidate/));
      await user.click(screen.getByRole("button", { name: "Pause" }));

      expect(mockBulkAction).toHaveBeenCalledWith("pause_candidates", [5]);
    });

    it("calls bulkPipelineAction('delete_selected', ids) when Cancel is confirmed", async () => {
      const tracks = [
        makeTrack({ id: 7, acquisition_status: "candidate" }),
        makeTrack({ id: 8, acquisition_status: "paused" }),
      ];
      setupMocks(tracks, { candidate: 1, paused: 1 });
      const user = userEvent.setup();

      render(<PipelineMonitorPage />);
      await screen.findByText("Track 7");

      await selectTrackByTitle(user, "Track 7");
      await selectTrackByTitle(user, "Track 8");
      await user.click(screen.getByText(/Cancel 2 Tracks/));
      await user.click(screen.getByRole("button", { name: "Delete" }));

      expect(mockBulkAction).toHaveBeenCalledWith("delete_selected", [7, 8]);
    });

    it("calls bulkPipelineAction('resume_paused', ids) when Resume is confirmed", async () => {
      const tracks = [
        makeTrack({ id: 3, acquisition_status: "paused" }),
      ];
      setupMocks(tracks, { paused: 1 });
      const user = userEvent.setup();

      render(<PipelineMonitorPage />);
      await screen.findByText("Track 3");

      await selectTrackByTitle(user, "Track 3");
      await user.click(screen.getByText(/Resume 1 Paused/));
      await user.click(screen.getByRole("button", { name: "Resume" }));

      expect(mockBulkAction).toHaveBeenCalledWith("resume_paused", [3]);
    });

    it("calls bulkPipelineAction('retry_failed', ids) when Retry is confirmed", async () => {
      const tracks = [
        makeTrack({ id: 4, acquisition_status: "failed" }),
      ];
      setupMocks(tracks, { failed: 1 });
      const user = userEvent.setup();

      render(<PipelineMonitorPage />);
      await screen.findByText("Track 4");

      await selectTrackByTitle(user, "Track 4");
      await user.click(screen.getByText(/Retry 1 Failed/));

      const dialog = screen.getByText("Retry Selected Failed").closest("div[style]")!;
      await user.click(within(dialog as HTMLElement).getByRole("button", { name: "Retry" }));

      expect(mockBulkAction).toHaveBeenCalledWith("retry_failed", [4]);
    });
  });
});
