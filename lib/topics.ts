export type TopicPreset = {
  id: string;
  label: string;
  prompt: string;
  vibe: string;
  randomAngles: string[];
  titleKeywords: string[];
  descriptionKeywords: string[];
  keywordRule: string;
};

const UNIQUENESS_ENFORCEMENT = `

UNIQUENESS ENFORCEMENT:
- The content must feel fresh and non-repetitive across multiple generations.
- Prefer uncommon, niche, or recently discovered information.
- If a fact feels familiar or widely known, replace it with a more obscure alternative.
- Avoid fallback to generic high-probability facts.`;

export const topicPresets: TopicPreset[] = [
  {
    id: "obscure-facts",
    label: "Obscure Facts Engine",
    prompt: `Generate 5 obscure, surprising facts from mixed domains (science, history, psychology, tech, culture).

Additional Rules:
- Avoid ALL commonly known viral facts.
- Each fact must be niche, rarely discussed, or counterintuitive.
- Prefer recent discoveries, hidden historical events, or overlooked phenomena.
- Facts must NOT overlap with generic "top 10 facts" content.
- Each fact should feel like a "how is this real?" moment.

ANTI-REPETITION:
- Do not reuse common internet facts.
- Bias toward long-tail, low-frequency knowledge.`,
    vibe: "fast, curiosity-driven, slightly dramatic",
    randomAngles: [
      "from the last 10 years",
      "that scientists still can't explain",
      "that sound illegal but aren't",
      "that happened by accident",
      "about things you use every day",
      "that were classified until recently",
      "from countries you've never heard of",
      "that contradict common sense"
    ],
    titleKeywords: ["obscure facts", "unknown facts"],
    descriptionKeywords: ["obscure facts", "unknown facts"],
    keywordRule: "Title must include at least one of: 'obscure facts' or 'unknown facts'."
  },
  {
    id: "sounds-fake-but-real",
    label: "Sounds Fake But Real",
    prompt: `Real things that sound completely fake but are true.

Additional Rules:
- Each item must sound absurd but be real.
- Avoid overused examples.
- Prefer modern science, weird laws, rare events, or odd discoveries.
- Each segment should escalate in absurdity.

ANTI-REPETITION:
- Avoid popular "did you know" content.
- Prioritize unique or lesser-known examples.`,
    vibe: "disbelief, punchy, mind-bending",
    randomAngles: [
      "from the animal kingdom",
      "about space and physics",
      "about the human body",
      "from modern technology",
      "about food and agriculture",
      "from world governments",
      "about ancient civilizations",
      "from the ocean depths"
    ],
    titleKeywords: ["sounds fake", "but it's real", "unbelievable facts"],
    descriptionKeywords: ["sounds fake", "but it's real", "unbelievable facts"],
    keywordRule: "Use 'sounds fake' and 'but it's real' together in the title or split across title and description."
  },
  {
    id: "creepy-knowledge",
    label: "Creepy Knowledge",
    prompt: `Unsettling or creepy facts that feel wrong to know.

Additional Rules:
- No graphic or policy-violating content.
- Focus on psychological, technological, or real-world oddities.
- Avoid mainstream horror trivia.
- Each fact should create discomfort or unease.

ANTI-REPETITION:
- Avoid commonly cited creepy facts.
- Prefer obscure or lesser-discussed information.`,
    vibe: "eerie, tense, curiosity-hooking",
    randomAngles: [
      "about your own brain",
      "that keep scientists up at night",
      "about everyday objects",
      "from the deep web era",
      "about sleep and dreams",
      "that were covered up",
      "about artificial intelligence",
      "from abandoned places"
    ],
    titleKeywords: ["creepy facts", "disturbing facts"],
    descriptionKeywords: ["creepy facts", "disturbing facts"],
    keywordRule: "Use one of 'creepy facts' or 'disturbing facts' in the title, and the other in the description."
  },
  {
    id: "tiny-mistakes-huge-consequences",
    label: "Tiny Mistakes → Huge Consequences",
    prompt: `Small mistakes that led to massive real-world consequences.

Additional Rules:
- Each example must be concise and impactful.
- Avoid overused events.
- Focus on lesser-known incidents.
- Emphasize cause → consequence clearly.

ANTI-REPETITION:
- Avoid famous textbook examples.
- Prefer unique or underreported stories.`,
    vibe: "storytelling, dramatic, cause-effect",
    randomAngles: [
      "in the tech industry",
      "that changed entire countries",
      "in medicine and science",
      "that cost billions of dollars",
      "in military history",
      "in space exploration",
      "that happened this century",
      "involving a single typo or digit"
    ],
    titleKeywords: ["tiny mistakes", "changed history", "history facts"],
    descriptionKeywords: ["tiny mistakes", "changed history", "history facts"],
    keywordRule: "Combine 'tiny mistakes' and 'changed history' in the title whenever possible."
  },
  {
    id: "hidden-human-abilities",
    label: "Hidden Human Abilities",
    prompt: `Lesser-known abilities or quirks of the human body.

Additional Rules:
- Avoid common textbook facts.
- Focus on surprising or rare mechanisms.
- Must feel new to an average viewer.
- Keep explanations simple but impactful.

ANTI-REPETITION:
- Avoid widely known biology facts.
- Prefer niche or surprising findings.`,
    vibe: "mind-blowing, educational but fast-paced",
    randomAngles: [
      "that activate under extreme stress",
      "related to your senses",
      "about your brain's hidden features",
      "that only some people have",
      "about healing and recovery",
      "discovered in the last decade",
      "about muscle memory and reflexes",
      "that babies can do but adults can't"
    ],
    titleKeywords: ["human body secrets", "body facts"],
    descriptionKeywords: ["human body secrets", "body facts"],
    keywordRule: "Title must include one of 'human body secrets' or 'body facts'. Description must include both."
  },
  {
    id: "internet-mysteries",
    label: "Internet Mysteries",
    prompt: `Lesser-known internet mysteries or unexplained events.

Additional Rules:
- Avoid famous cases unless presenting a rare angle.
- Prefer obscure or recent mysteries.
- Keep narrative slightly unresolved.

ANTI-REPETITION:
- Avoid commonly covered internet mysteries.
- Prioritize niche or forgotten cases.`,
    vibe: "suspenseful, mysterious, intriguing",
    randomAngles: [
      "from the early internet era",
      "that were never solved",
      "involving anonymous users",
      "from the dark web",
      "that turned out to be real",
      "involving coded messages",
      "from forgotten forums",
      "that went viral then vanished"
    ],
    titleKeywords: ["internet mystery", "unsolved internet"],
    descriptionKeywords: ["internet mystery", "unsolved internet"],
    keywordRule: "At least one of 'internet mystery' or 'unsolved internet' must appear in the title."
  },
  {
    id: "things-that-shouldnt-exist",
    label: "Things That Shouldn't Exist",
    prompt: `Bizarre real-world things that seem impossible but exist.

Additional Rules:
- Must be visually interesting (important for stock footage).
- Avoid commonly viral examples.
- Focus on strange places, objects, or phenomena.

ANTI-REPETITION:
- Avoid overused "weird facts".
- Prefer visually unique, lesser-known subjects.`,
    vibe: "shocking, visual-heavy, absurd",
    randomAngles: [
      "in nature",
      "created by humans",
      "found underwater",
      "in extreme environments",
      "that defy physics",
      "discovered recently",
      "in remote locations",
      "that science can't fully explain"
    ],
    titleKeywords: ["shouldn't exist", "real but weird", "weird things"],
    descriptionKeywords: ["shouldn't exist", "real but weird", "weird things"],
    keywordRule: "Prefer 'shouldn't exist' in the title."
  },
  {
    id: "psychology-tricks",
    label: "Psychology Tricks",
    prompt: `Psychological effects or tricks that actually work in real life.

Additional Rules:
- Avoid overused concepts (placebo, basic anchoring, etc.).
- Must be applicable or relatable.
- Keep explanations short and impactful.

ANTI-REPETITION:
- Avoid mainstream psychology examples.
- Prefer lesser-known cognitive effects.`,
    vibe: "practical, fast, slightly manipulative-feeling",
    randomAngles: [
      "used in marketing",
      "that influence first impressions",
      "for negotiations",
      "that social media exploits",
      "backed by recent studies",
      "used by law enforcement",
      "that work on yourself",
      "about persuasion and trust"
    ],
    titleKeywords: ["psychology tricks", "mind tricks"],
    descriptionKeywords: ["psychology tricks", "mind tricks"],
    keywordRule: "Use one of 'psychology tricks' or 'mind tricks' in the title, and the other in the description."
  },
  {
    id: "dark-side-of-everyday-things",
    label: "Dark Side of Everyday Things",
    prompt: `Hidden or unexpected downsides of everyday things.

Additional Rules:
- Start with familiar items (phones, habits, food, etc.).
- Reveal something unexpected or unknown.
- Avoid obvious or commonly discussed downsides.

ANTI-REPETITION:
- Avoid widely known negative facts.
- Focus on surprising or lesser-known angles.`,
    vibe: "relatable → twist → eye-opening",
    randomAngles: [
      "about your morning routine",
      "about common foods",
      "about technology you trust",
      "about your home",
      "about popular habits",
      "about workplace norms",
      "about social media",
      "about things marketed as healthy"
    ],
    titleKeywords: ["dark side", "hidden truth"],
    descriptionKeywords: ["dark side", "hidden truth"],
    keywordRule: "Use 'dark side' in the title and 'hidden truth' in the description."
  },
  {
    id: "one-insane-story",
    label: "One Insane Story",
    prompt: `One bizarre real story told in a fast-paced narrative.

Additional Rules:
- Must follow: hook → setup → twist → ending.
- Keep story concise but impactful.
- Avoid overused viral stories.

ANTI-REPETITION:
- Avoid famous or commonly told stories.
- Prefer obscure or unique narratives.`,
    vibe: "storytelling, intense, engaging",
    randomAngles: [
      "from the last 5 years",
      "involving a con artist",
      "about a scientific disaster",
      "about an unsolved crime",
      "about a survival situation",
      "involving corporate espionage",
      "from a small town",
      "that sounds like fiction"
    ],
    titleKeywords: ["insane story", "true story"],
    descriptionKeywords: ["insane story", "true story"],
    keywordRule: "Both 'insane story' and 'true story' should appear (split across title and description is fine)."
  }
];

/**
 * Build the full topic prompt with a random sub-angle and uniqueness enforcement.
 */
export function buildTopicPrompt(
  topicId: string,
  aspectRatio: string,
  previousFacts?: string[]
): { prompt: string; vibe: string } | undefined {
  const topic = topicPresets.find((t) => t.id === topicId);
  if (!topic) return undefined;

  const angle = topic.randomAngles[Math.floor(Math.random() * topic.randomAngles.length)];

  let prompt = `TOPIC: ${topic.prompt.split("\n")[0]} with a random sub-angle: ${angle}

Narrative vibe: ${topic.vibe}
Aspect ratio: ${aspectRatio}

${topic.prompt}${UNIQUENESS_ENFORCEMENT}

YOUTUBE TITLE & DESCRIPTION KEYWORDS:
- Title keywords to use: ${topic.titleKeywords.join(", ")}
- Description keywords to use: ${topic.descriptionKeywords.join(", ")}
- Rule: ${topic.keywordRule}
- The YouTube description should be long-form, CTR-optimized, and target roughly 2000+ characters. Use the description keywords naturally throughout it without obvious stuffing.`;

  if (previousFacts && previousFacts.length > 0) {
    prompt += `\n\nPREVIOUSLY USED CONTENT (do NOT reuse any of these facts, stories, or examples):\n${previousFacts.map((f, i) => `${i + 1}. ${f}`).join("\n")}`;
  }

  return { prompt, vibe: topic.vibe };
}

export function getTopicById(id: string) {
  return topicPresets.find((t) => t.id === id);
}
