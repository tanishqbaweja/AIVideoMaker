export type TextToken = {
  word: string;
  normalized: string;
};

const WORD_TOKEN_PATTERN = /[A-Za-z0-9]+(?:['’‘`´-‐‑‒–—][A-Za-z0-9]+)*/g;
const APOSTROPHE_VARIANTS_PATTERN = /[’‘`´]/g;
const DASH_VARIANTS_PATTERN = /[‐‑‒–—]/g;

export function stripAudioTags(text: string) {
  return text.replace(/\[[^\]\r\n]{1,80}\]/g, " ").replace(/\s+/g, " ").trim();
}

export function tokenizeWords(text: string): TextToken[] {
  const cleanText = stripAudioTags(text);
  const matches = cleanText.match(WORD_TOKEN_PATTERN) ?? [];

  return matches
    .map((word) => {
      const canonicalWord = canonicalizeWordSurface(word);
      return { word: canonicalWord, normalized: normalizeWord(canonicalWord) };
    })
    .filter((token) => token.normalized.length > 0);
}

export function normalizeWord(word: string) {
  return canonicalizeWordSurface(word).toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function canonicalizeWordSurface(word: string) {
  return word
    .replace(APOSTROPHE_VARIANTS_PATTERN, "'")
    .replace(DASH_VARIANTS_PATTERN, "-");
}

export function buildKeywordSet(keywords: string[]) {
  const keywordSet = new Set<string>();

  for (const keyword of keywords) {
    for (const token of tokenizeWords(keyword)) {
      keywordSet.add(token.normalized);
    }
  }

  return keywordSet;
}

export type TimedSegment = {
  start: number;
  end: number;
  text: string;
};

export type TextAlignmentCoverage = {
  referenceWordCount: number;
  candidateWordCount: number;
  matchedWordCount: number;
  referenceCoverage: number;
  candidateCoverage: number;
};

export function getTextAlignmentCoverage(
  referenceText: string,
  candidateText: string
): TextAlignmentCoverage {
  const referenceTokens = tokenizeWords(referenceText);
  const candidateTokens = tokenizeWords(candidateText);
  const matchedWordCount = buildExactAlignmentMap(referenceTokens, candidateTokens).size;

  return {
    referenceWordCount: referenceTokens.length,
    candidateWordCount: candidateTokens.length,
    matchedWordCount,
    referenceCoverage: referenceTokens.length > 0
      ? matchedWordCount / referenceTokens.length
      : 0,
    candidateCoverage: candidateTokens.length > 0
      ? matchedWordCount / candidateTokens.length
      : 0
  };
}

export function correctTimedSegmentsToScript(segments: TimedSegment[], scriptText: string) {
  const scriptTokens = tokenizeWords(scriptText);
  if (scriptTokens.length === 0 || segments.length === 0) {
    return segments;
  }

  const transcriptTokens = segments.flatMap((segment) => tokenizeWords(segment.text));
  const transcriptWordCount = transcriptTokens.length;
  if (transcriptWordCount === 0) {
    return segments;
  }

  const transcriptBoundaries = [0];
  let consumedTranscriptWords = 0;
  for (const segment of segments) {
    consumedTranscriptWords += tokenizeWords(segment.text).length;
    transcriptBoundaries.push(consumedTranscriptWords);
  }

  const scriptBoundaries = mapTranscriptBoundariesToScript(
    transcriptBoundaries,
    buildBoundaryAnchors(scriptTokens, transcriptTokens),
    scriptTokens.length,
    transcriptWordCount
  );

  return segments.map((segment, index) => {
    const startIndex = scriptBoundaries[index];
    const endIndex = Math.max(startIndex + 1, scriptBoundaries[index + 1]);
    const correctedWords = scriptTokens.slice(startIndex, endIndex).map((token) => token.word).join(" ");

    return {
      start: segment.start,
      end: segment.end,
      text: correctedWords || segment.text
    };
  });
}

type BoundaryAnchor = {
  transcriptBoundary: number;
  scriptBoundary: number;
};

function mapTranscriptBoundariesToScript(
  transcriptBoundaries: number[],
  anchors: BoundaryAnchor[],
  scriptWordCount: number,
  transcriptWordCount: number
) {
  const boundaries = transcriptBoundaries.map((boundary, index) => {
    const mapped = interpolateBoundary(boundary, anchors, scriptWordCount, transcriptWordCount);
    const minBoundary = index === 0 ? 0 : transcriptBoundaries.length - index - 1;
    return mapped;
  });

  boundaries[0] = 0;
  boundaries[boundaries.length - 1] = scriptWordCount;

  for (let index = 1; index < boundaries.length; index += 1) {
    const minimum = boundaries[index - 1] + (index === boundaries.length - 1 ? 0 : 1);
    const maximum = scriptWordCount - (transcriptBoundaries.length - index - 1);
    boundaries[index] = clampBoundary(boundaries[index], minimum, maximum);
  }

  return boundaries;
}

function buildBoundaryAnchors(scriptTokens: TextToken[], transcriptTokens: TextToken[]) {
  const exactMap = buildExactAlignmentMap(scriptTokens, transcriptTokens);
  const anchors: BoundaryAnchor[] = [{ transcriptBoundary: 0, scriptBoundary: 0 }];

  for (const [scriptIndex, transcriptIndex] of exactMap.entries()) {
    anchors.push({
      transcriptBoundary: transcriptIndex + 1,
      scriptBoundary: scriptIndex + 1
    });
  }

  anchors.sort((left, right) => left.transcriptBoundary - right.transcriptBoundary);
  anchors.push({
    transcriptBoundary: transcriptTokens.length,
    scriptBoundary: scriptTokens.length
  });

  return anchors;
}

function interpolateBoundary(
  transcriptBoundary: number,
  anchors: BoundaryAnchor[],
  scriptWordCount: number,
  transcriptWordCount: number
) {
  for (let index = 0; index < anchors.length - 1; index += 1) {
    const current = anchors[index];
    const next = anchors[index + 1];

    if (transcriptBoundary < current.transcriptBoundary || transcriptBoundary > next.transcriptBoundary) {
      continue;
    }

    if (next.transcriptBoundary === current.transcriptBoundary) {
      return current.scriptBoundary;
    }

    const ratio = (transcriptBoundary - current.transcriptBoundary) / (next.transcriptBoundary - current.transcriptBoundary);
    return Math.round(current.scriptBoundary + ratio * (next.scriptBoundary - current.scriptBoundary));
  }

  return Math.round((transcriptBoundary / Math.max(1, transcriptWordCount)) * scriptWordCount);
}

function buildExactAlignmentMap(scriptTokens: TextToken[], transcriptTokens: TextToken[]) {
  const dp = Array.from({ length: scriptTokens.length + 1 }, () =>
    Array<number>(transcriptTokens.length + 1).fill(0)
  );

  for (let i = scriptTokens.length - 1; i >= 0; i -= 1) {
    for (let j = transcriptTokens.length - 1; j >= 0; j -= 1) {
      dp[i][j] = scriptTokens[i].normalized === transcriptTokens[j].normalized
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const map = new Map<number, number>();
  let i = 0;
  let j = 0;

  while (i < scriptTokens.length && j < transcriptTokens.length) {
    if (scriptTokens[i].normalized === transcriptTokens[j].normalized) {
      map.set(i, j);
      i += 1;
      j += 1;
      continue;
    }

    if (dp[i + 1][j] >= dp[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }

  return map;
}

function clampBoundary(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}
