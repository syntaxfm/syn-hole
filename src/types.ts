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

export type AdminPollImageOption = {
  id: string;
  label: string;
  image: (PollOptionImage & { size: number }) | null;
};

export type AdminPollImageQuestion = {
  index: number;
  id: string;
  prompt: string;
  correctOptionIds: string[];
  options: AdminPollImageOption[];
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
            winningGuess: number | null;
            winnerCount: number;
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
