import type { PlayMode } from "~/types";

/** Independent from PollQuestion: library edits never mutate a prepared game. */
export type SyntaxPoint = Readonly<{ x: number; y: number }>;
export type SyntaxTarget = SyntaxPoint & Readonly<{
  /** Fraction of ORIGINAL IMAGE WIDTH, not height or diagonal. */
  radius: number;
}>;
export type SyntaxImage = Readonly<{
  /** Stable immutable asset URL/key; replacing bytes must produce a new URL. */
  url: string;
  width: number;
  height: number;
  alt: string;
}>;
export type SyntaxLibraryEntry = Readonly<{
  id: string;
  title: string;
  image: SyntaxImage;
  targets: readonly SyntaxTarget[];
  explanation: string;
}>;
export type SyntaxSubmissionMode = "first-click" | "confirm";
export type SyntaxSavedRound = Readonly<{
  entryId: string;
  durationMs?: number;
}>;
/** Repeated entryIds are intentional: the ordered set may reuse an image. */
export type SyntaxSavedSet = Readonly<{
  id: string;
  title: string;
  defaultDurationMs: number;
  submissionMode: SyntaxSubmissionMode;
  rounds: readonly SyntaxSavedRound[];
}>;
export type SyntaxRoundSnapshot = Readonly<{
  entry: SyntaxLibraryEntry;
  durationMs: number;
}>;
export type SyntaxSessionSnapshot = Readonly<{
  id: string;
  setId: string;
  title: string;
  preparedAt: number;
  submissionMode: SyntaxSubmissionMode;
  /** Capture the room setting, not each client's preference. */
  askPlayMode: boolean;
  rounds: readonly SyntaxRoundSnapshot[];
}>;
export type SyntaxPhase = "prepared" | "open" | "closed" | "revealed" | "finished" | "aborted";
export type SyntaxPlayer = Readonly<{
  id: string;
  name: string;
  playMode: PlayMode | null;
}>;
/** Server-only. A timeout is absence of an answer, never a fabricated click. */
export type SyntaxAnswer = Readonly<{
  playerId: string;
  roundIndex: number;
  point: SyntaxPoint;
  receivedAt: number;
  /** Persisted by runtime; optional for older/domain-only records. */
  elapsedMs?: number;
  correct: boolean;
  points: number;
}>;
export type SyntaxTiming = Readonly<{ openedAt: number; deadlineAt: number }>;
export type SyntaxSession = Readonly<{
  snapshot: SyntaxSessionSnapshot;
  phase: SyntaxPhase;
  roundIndex: number;
  timing: SyntaxTiming | null;
  players: readonly SyntaxPlayer[];
  answers: readonly SyntaxAnswer[];
  /** Explicitly revealed only; abort does not reveal the current answer. */
  revealedRoundIndexes: readonly number[];
}>;
export type SyntaxStanding = Readonly<{
  playerId: string;
  name: string;
  playMode: PlayMode | null;
  points: number;
  correct: number;
  answered: number;
  rank: number;
}>;
export type SyntaxGroupStandings = Readonly<{
  playMode: PlayMode | null;
  standings: readonly SyntaxStanding[];
  total: number;
}>;
/** Correct responders ONLY, ranked fastest by elapsedMs within their group. */
export type SyntaxRoundStanding = Readonly<{
  playerId: string;
  name: string;
  playMode: PlayMode | null;
  elapsedMs: number;
  rank: number;
}>;
export type SyntaxRoundGroupStandings = Readonly<{
  playMode: PlayMode | null;
  standings: readonly SyntaxRoundStanding[];
  total: number;
}>;
/** No identity, correctness, score, time or ordering linkage on anonymous dots. */
export type SyntaxClickPage = Readonly<{
  roundIndex: number;
  points: readonly SyntaxPoint[];
  total: number;
  nextOffset: number | null;
}>;
/** Deliberate allowlists, not stored objects with fields deleted. */
export type SyntaxRoundPublic = Readonly<{
  roundIndex: number;
  title: string;
  image: SyntaxImage;
  durationMs: number;
}>;
export type SyntaxRoundRevealed = SyntaxRoundPublic & Readonly<{
  targets: readonly SyntaxTarget[];
  explanation: string;
  yourResult: Readonly<{ correct: boolean; points: number }> | null;
}>;
export type SyntaxSessionPublic = Readonly<{
  id: string;
  title: string;
  phase: SyntaxPhase;
  submissionMode: SyntaxSubmissionMode;
  totalRounds: number;
  askPlayMode: boolean;
  currentRound: SyntaxRoundPublic;
  timing: SyntaxTiming | null;
  participants: number;
  totalResponses: number;
  yourSubmission: SyntaxPoint | null;
  reveal: SyntaxRoundRevealed | null;
  /** At most the most recent explicit reveal (not an archive/export API). */
  history: readonly SyntaxRoundRevealed[];
  standings: readonly SyntaxGroupStandings[];
  /** Cumulative standings contain ONLY explicitly revealed rounds. Lists are
   * bounded; personal rows/ranks remain available even outside visible lists. */
  yourStanding: SyntaxStanding | null;
  /** Top 20 correct responders per group; absent until CURRENT round reveal. */
  roundStandings: readonly SyntaxRoundGroupStandings[];
  yourRoundStanding: SyntaxRoundStanding | null;
  /** Current round only, and only after explicit reveal. Additional anonymous
   * pages can be requested; past full image/target history is not rebroadcast. */
  clicks: SyntaxClickPage | null;
  revealedRounds: number;
}>;
