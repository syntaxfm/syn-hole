export type PollRole = "audience" | "host" | "projector";
export type PollPhase = "idle" | "open" | "closed" | "revealed";

export type PollOption = {
  id: string;
  label: string;
};

/** "image" shows each option as an uploaded image; the option label becomes its alt text. */
export type PollChoiceDisplay = "text" | "image";

export type PollChoiceQuestion = {
  kind: "choice";
  id: string;
  prompt: string;
  options: PollOption[];
  correctOptionIds: string[];
  allowMultiple: boolean;
  hideResultsUntilReveal?: boolean;
  display?: PollChoiceDisplay;
};

export type PollOptionImage = {
  url: string;
  width: number;
  height: number;
};

export type StoredOptionImage = PollOptionImage & { size: number };

/** A room's uploaded images, by question id then option id. */
export type RoomOptionImages = Record<string, Record<string, StoredOptionImage>>;

/** What to replace a room's questions with: the starter list, nothing, or a copy of another room. */
export type ReplaceQuestionsSource =
  | { kind: "starter" }
  | { kind: "empty" }
  | { kind: "room"; room: string };

export type RoomQuestionsResponse = {
  questions: PollQuestion[];
  images: RoomOptionImages;
};

export type PollNumberQuestion = {
  kind: "number";
  id: string;
  prompt: string;
  correctNumber: number;
  min?: number;
  max?: number;
  step?: number;
  hideResultsUntilReveal?: boolean;
};

export type PollQuestion = PollChoiceQuestion | PollNumberQuestion;

export type PollChoiceQuestionPublic = Omit<PollChoiceQuestion, "correctOptionIds">;
export type PollNumberQuestionPublic = Omit<PollNumberQuestion, "correctNumber">;
export type PollQuestionPublic = PollChoiceQuestionPublic | PollNumberQuestionPublic;

export type VoteCounts = Record<string, number>;

/** Where an audience member is playing from. Rooms can ask so each group gets its own winners. */
export type PlayMode = "in-person" | "online";

export type RoomSettings = {
  /** Ask each player on the join screen whether they're in person or online. */
  askPlayMode: boolean;
};

/** Closest guess without going over. playMode is null when the room doesn't split players. */
export type NumberWinner = {
  playMode: PlayMode | null;
  winningGuess: number | null;
  winnerCount: number;
};

export type IncomingMessage =
  | {
      type: "vote";
      optionIds: string[];
    }
  | {
      type: "vote-number";
      value: number | null;
    }
  | {
      type: "set-question";
      questionIndex: number;
    }
  | {
      type: "open-voting";
    }
  | {
      type: "close-voting";
    }
  | {
      type: "reveal";
    }
  | {
      type: "reset-session";
    };

export type OutgoingMessage =
  | {
      type: "state";
      role: PollRole;
      room: string;
      phase: PollPhase;
      currentQuestionIndex: number;
      totalQuestions: number;
      askPlayMode: boolean;
      question: PollQuestionPublic | null;
      /** Images for the current question, keyed by option id. Empty unless display is "image". */
      optionImages: Record<string, PollOptionImage>;
      voteCounts: VoteCounts;
      resultsVisible: boolean;
      totalResponses: number;
      participants: number;
      yourVoteOptionIds: string[];
      yourNumberGuess: number | null;
      score:
        | {
            answered: number;
            correct: number;
            totalQuestions: number;
          }
        | null;
      reveal:
        | {
            kind: "choice";
            correctOptionIds: string[];
            isCorrect?: boolean;
          }
        | {
            kind: "number";
            correctNumber: number;
            /** One entry, or one per play mode when the room asks for it. */
            winners: NumberWinner[];
            isWinner?: boolean;
          }
        | null;
      host:
        | {
            questions: PollQuestion[];
          }
        | null;
    }
  | {
      type: "error";
      message: string;
    };
