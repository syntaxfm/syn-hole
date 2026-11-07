import type {
  PollChoiceDisplay,
  PollChoiceQuestion,
  PollNumberQuestion,
  PollOption,
  PollQuestion,
} from "~/types";
import { isSafeKeySegment } from "~/utils/poll-images";

export type QuestionType = "text" | "image" | "number";

/** Validates one stored or submitted question. Throws with a message naming the question. */
export function parseQuestion(rawQuestion: unknown, index: number): PollQuestion {
  if (!rawQuestion || typeof rawQuestion !== "object") {
    throw new Error(`Question at index ${index} must be an object.`);
  }

  const question = rawQuestion as Record<string, unknown>;
  const id = question.id;
  const prompt = question.prompt;
  const hideResultsUntilReveal = question.hideResultsUntilReveal;

  if (typeof id !== "string" || !isSafeKeySegment(id)) {
    throw new Error(`Question at index ${index} needs an id of letters, numbers, "-" or "_".`);
  }
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    throw new Error(`Question "${id}" has an invalid "prompt".`);
  }
  if (hideResultsUntilReveal !== undefined && typeof hideResultsUntilReveal !== "boolean") {
    throw new Error(`Question "${id}" has invalid "hideResultsUntilReveal" (must be boolean).`);
  }

  if (question.kind === "number") return parseNumberQuestion(question, id, prompt);
  if (question.kind !== undefined && question.kind !== "choice") {
    throw new Error(`Question "${id}" has unknown kind "${String(question.kind)}".`);
  }
  return parseChoiceQuestion(question, id, prompt);
}

/** Validates a whole list: each question plus unique ids. */
export function parseQuestionList(rawQuestions: unknown): PollQuestion[] {
  if (!Array.isArray(rawQuestions)) {
    throw new Error("Questions must be an array.");
  }
  const ids = new Set<string>();
  return rawQuestions.map((rawQuestion, index) => {
    const question = parseQuestion(rawQuestion, index);
    if (ids.has(question.id)) {
      throw new Error(`Duplicate question id "${question.id}".`);
    }
    ids.add(question.id);
    return question;
  });
}

function parseNumberQuestion(
  question: Record<string, unknown>,
  id: string,
  prompt: string
): PollNumberQuestion {
  const { correctNumber, min, max, step } = question;
  if (typeof correctNumber !== "number" || !Number.isFinite(correctNumber)) {
    throw new Error(`Question "${id}" must include numeric "correctNumber".`);
  }
  if (min !== undefined && (typeof min !== "number" || !Number.isFinite(min))) {
    throw new Error(`Question "${id}" has invalid "min".`);
  }
  if (max !== undefined && (typeof max !== "number" || !Number.isFinite(max))) {
    throw new Error(`Question "${id}" has invalid "max".`);
  }
  if (step !== undefined && (typeof step !== "number" || !Number.isFinite(step) || step <= 0)) {
    throw new Error(`Question "${id}" has invalid "step" (must be > 0).`);
  }
  if (typeof min === "number" && typeof max === "number" && min > max) {
    throw new Error(`Question "${id}" has min greater than max.`);
  }

  return {
    kind: "number",
    id,
    prompt,
    correctNumber,
    min: typeof min === "number" ? min : undefined,
    max: typeof max === "number" ? max : undefined,
    step: typeof step === "number" ? step : undefined,
    hideResultsUntilReveal: question.hideResultsUntilReveal === true,
  };
}

function parseChoiceQuestion(
  question: Record<string, unknown>,
  id: string,
  prompt: string
): PollChoiceQuestion {
  const { allowMultiple, options, correctOptionIds } = question;
  const display = parseChoiceDisplay(question.display, id);

  if (typeof allowMultiple !== "boolean") {
    throw new Error(`Question "${id}" must include boolean "allowMultiple".`);
  }
  if (!Array.isArray(options) || options.length < 2) {
    throw new Error(`Question "${id}" must include at least two options.`);
  }
  if (!Array.isArray(correctOptionIds) || correctOptionIds.length === 0) {
    throw new Error(`Question "${id}" must include one or more correctOptionIds.`);
  }

  const optionIds = new Set<string>();
  const validatedOptions: PollOption[] = options.map((rawOption, optionIndex) => {
    if (!rawOption || typeof rawOption !== "object") {
      throw new Error(`Question "${id}" option at index ${optionIndex} must be an object.`);
    }
    const option = rawOption as Record<string, unknown>;
    if (typeof option.id !== "string" || !isSafeKeySegment(option.id)) {
      throw new Error(`Question "${id}" has an option with an invalid "id".`);
    }
    if (typeof option.label !== "string" || option.label.trim().length === 0) {
      throw new Error(`Question "${id}" option "${option.id}" has invalid "label".`);
    }
    if (optionIds.has(option.id)) {
      throw new Error(`Question "${id}" has duplicate option id "${option.id}".`);
    }
    optionIds.add(option.id);
    return { id: option.id, label: option.label };
  });

  const validatedCorrectOptionIds: string[] = [];
  for (const rawCorrectOptionId of correctOptionIds) {
    if (typeof rawCorrectOptionId !== "string") {
      throw new Error(`Question "${id}" has non-string correctOptionIds entries.`);
    }
    if (!optionIds.has(rawCorrectOptionId)) {
      throw new Error(`Question "${id}" references unknown correct option "${rawCorrectOptionId}".`);
    }
    if (!validatedCorrectOptionIds.includes(rawCorrectOptionId)) {
      validatedCorrectOptionIds.push(rawCorrectOptionId);
    }
  }

  if (!allowMultiple && validatedCorrectOptionIds.length > 1) {
    throw new Error(`Question "${id}" has multiple correct options but allowMultiple is false.`);
  }

  return {
    kind: "choice",
    id,
    prompt,
    allowMultiple,
    hideResultsUntilReveal: question.hideResultsUntilReveal === true,
    display,
    options: validatedOptions,
    correctOptionIds: validatedCorrectOptionIds,
  };
}

function parseChoiceDisplay(value: unknown, questionId: string): PollChoiceDisplay {
  if (value === undefined || value === "text") return "text";
  if (value === "image") return "image";
  throw new Error(`Question "${questionId}" has invalid "display" (use "text" or "image").`);
}

/** Plain-language problem for the editor, or null when the question can be saved. */
export function getQuestionIssue(question: PollQuestion): string | null {
  if (question.prompt.trim().length === 0) return "Add the question text.";
  if (question.kind === "number") {
    if (!Number.isFinite(question.correctNumber)) return "Set the correct number.";
    if (question.min !== undefined && question.max !== undefined && question.min > question.max) {
      return "Min is higher than max.";
    }
    return null;
  }
  if (question.options.length < 2) return "Add at least 2 options.";
  if (question.options.some((option) => option.label.trim().length === 0)) {
    return question.display === "image" ? "Give every image a description." : "Fill in every option.";
  }
  if (question.correctOptionIds.length === 0) return "Mark the correct answer.";
  if (!question.allowMultiple && question.correctOptionIds.length > 1) {
    return "Mark one correct answer, or allow multiple.";
  }
  return null;
}

export function getQuestionType(question: PollQuestion): QuestionType {
  if (question.kind === "number") return "number";
  return question.display === "image" ? "image" : "text";
}

export function createEditorId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 10);
}

export function createOption(): PollOption {
  return { id: createEditorId(), label: "" };
}

export function createQuestion(type: QuestionType): PollQuestion {
  if (type === "number") {
    return { kind: "number", id: createEditorId(), prompt: "", correctNumber: 0, hideResultsUntilReveal: false };
  }
  return {
    kind: "choice",
    id: createEditorId(),
    prompt: "",
    display: type,
    allowMultiple: false,
    hideResultsUntilReveal: type === "image",
    options: [createOption(), createOption()],
    correctOptionIds: [],
  };
}

/** Switches type while keeping the id and prompt (and options between text and image). */
export function changeQuestionType(question: PollQuestion, type: QuestionType): PollQuestion {
  if (getQuestionType(question) === type) return question;
  if (type !== "number" && question.kind === "choice") return { ...question, display: type };
  return { ...createQuestion(type), id: question.id, prompt: question.prompt };
}

export function moveItem<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  if (toIndex < 0 || toIndex >= items.length || fromIndex === toIndex) return items;
  const next = [...items];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

export function parseQuestionType(value: string): QuestionType {
  return value === "image" || value === "number" ? value : "text";
}

/** "Option A", "Option B", … matching the letters the audience sees. */
export function getOptionName(index: number): string {
  return `Option ${String.fromCharCode(65 + (index % 26))}`;
}

/** Empty or non-numeric input means "not set". */
export function parseOptionalNumber(value: string): number | undefined {
  if (value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
