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
- Prefer uncommon, under-discussed, or counterintuitive Indian angles over obvious talking points.
- If a fact, idea, or comparison feels familiar, replace it with a more surprising Indian example.
- Avoid fallback to generic, textbook, or high-probability content.`;

export const topicPresets: TopicPreset[] = [
  {
    id: "mind-bending-india-facts",
    label: "Mind-Bending Indian Facts",
    prompt: `Mind-bending facts about India that can be understood without needing visuals.

Additional Rules:
- Facts must be concept-driven, not location-based.
- Avoid anything that requires specific visuals to understand.
- Focus on numbers, comparisons, or surprising truths.

ANTI-REPETITION:
- Avoid common India trivia.`,
    vibe: "fast, surprising, punchy",
    randomAngles: [
      "through shocking comparisons",
      "through population scale",
      "through hidden economic truths",
      "through weird historical patterns",
      "through systems most people overlook",
      "through everyday facts that sound fake",
      "through counterintuitive Indian realities",
      "through logic that sounds impossible at first"
    ],
    titleKeywords: ["India facts"],
    descriptionKeywords: ["mind blowing India"],
    keywordRule: "Title must include 'India facts'. Description must include 'mind blowing India'."
  },
  {
    id: "what-if-india-scenarios",
    label: "What If Scenarios (India Edition)",
    prompt: `Hypothetical "what if" scenarios related to India.

Additional Rules:
- Scenarios must be explainable through narration alone.
- Focus on outcomes, not visuals.
- Keep it logical but intriguing.

ANTI-REPETITION:
- Avoid generic hypothetical questions.`,
    vibe: "imaginative, curiosity-driven",
    randomAngles: [
      "about economy and money",
      "about traffic and transport",
      "about population-scale changes",
      "about education and exams",
      "about digital India systems",
      "about food, water, or electricity",
      "about taxes and government policy",
      "about cities functioning differently overnight"
    ],
    titleKeywords: ["what if India"],
    descriptionKeywords: ["India scenario"],
    keywordRule: "Title must include 'what if India'. Description must include 'India scenario'."
  },
  {
    id: "numbers-that-explain-india",
    label: "Numbers That Explain India",
    prompt: `Powerful numbers or statistics that reveal something surprising about India.

Additional Rules:
- Each point must revolve around a number or comparison.
- Make numbers feel shocking or meaningful.
- No need for visual dependency.

ANTI-REPETITION:
- Avoid overused statistics.`,
    vibe: "analytical but engaging",
    randomAngles: [
      "through scale alone",
      "through money comparisons",
      "through time-saving or time-loss",
      "through city versus village contrasts",
      "through internet and phone usage",
      "through food or consumption patterns",
      "through student or job numbers",
      "through comparisons most people never calculate"
    ],
    titleKeywords: ["India statistics", "India numbers"],
    descriptionKeywords: ["India statistics", "India numbers"],
    keywordRule: "Title must include either 'India statistics' or 'India numbers'. Description must include both 'India statistics' and 'India numbers'."
  },
  {
    id: "things-indians-think-are-normal",
    label: "Things Indians Think Are Normal",
    prompt: `Everyday Indian behaviors that feel normal locally but unusual globally.

Additional Rules:
- Must be understandable without visuals.
- Focus on behavior, culture, or mindset.
- Keep it light and relatable.

ANTI-REPETITION:
- Avoid cliche examples.`,
    vibe: "relatable, slightly humorous",
    randomAngles: [
      "inside family life",
      "in trains and public spaces",
      "around guests and hospitality",
      "in money habits",
      "around queues and waiting",
      "inside school or college life",
      "during weddings or festivals",
      "in tiny everyday social interactions"
    ],
    titleKeywords: ["only in India"],
    descriptionKeywords: ["Indian habits"],
    keywordRule: "Title must include 'only in India'. Description must include 'Indian habits'."
  },
  {
    id: "common-myths-indians-believe",
    label: "Common Myths Indians Believe",
    prompt: `Common myths or misconceptions widely believed in India.

Additional Rules:
- Clearly explain myth versus reality.
- Avoid sensitive or harmful topics.
- Focus on logic and explanation.

ANTI-REPETITION:
- Avoid overused myths.`,
    vibe: "debunking, engaging",
    randomAngles: [
      "about health",
      "about food habits",
      "about daily routines",
      "about money and success",
      "about school and intelligence",
      "about traditional advice",
      "about weather or seasons",
      "about things people repeat without checking"
    ],
    titleKeywords: ["Indian myths"],
    descriptionKeywords: ["India myths"],
    keywordRule: "Title must include 'Indian myths'. Description must include 'India myths'."
  },
  {
    id: "how-india-works",
    label: "How India Works (Explained Simply)",
    prompt: `Simple explanations of complex systems in India such as the economy, exams, infrastructure, or bureaucracy.

Additional Rules:
- Break down concepts simply.
- No reliance on visuals.
- Use analogies where helpful.

ANTI-REPETITION:
- Avoid generic explanations.`,
    vibe: "explanatory, clear, engaging",
    randomAngles: [
      "through one simple analogy",
      "through the lens of daily life",
      "through student experience",
      "through taxes or money flow",
      "through travel or transport",
      "through how cities function",
      "through jobs and competition",
      "through systems people use but don't understand"
    ],
    titleKeywords: ["India explained"],
    descriptionKeywords: ["how India works"],
    keywordRule: "Title must include 'India explained'. Description must include 'how India works'."
  },
  {
    id: "hidden-rules-of-indian-society",
    label: "Hidden Rules of Indian Society",
    prompt: `Unspoken social rules or patterns in Indian life.

Additional Rules:
- Focus on behavior and social norms.
- Must feel relatable to Indian viewers.
- No visual dependency.

ANTI-REPETITION:
- Avoid obvious stereotypes.`,
    vibe: "insightful, relatable",
    randomAngles: [
      "inside respect and hierarchy",
      "inside family expectations",
      "inside wedding and relationship culture",
      "around class and status signals",
      "inside neighborhood behavior",
      "around jobs and career respect",
      "inside hospitality and obligation",
      "around what people say versus what they mean"
    ],
    titleKeywords: ["unspoken rules India"],
    descriptionKeywords: ["Indian society"],
    keywordRule: "Title must include 'unspoken rules India'. Description must include 'Indian society'."
  },
  {
    id: "india-vs-world-comparisons",
    label: "Fast-Paced Comparisons (India vs World)",
    prompt: `Quick comparisons between India and other countries.

Additional Rules:
- Focus on differences that are surprising.
- Use numbers or logic instead of visuals.
- Keep it fast-paced.

ANTI-REPETITION:
- Avoid overused comparisons.`,
    vibe: "punchy, contrast-driven",
    randomAngles: [
      "through cost differences",
      "through population and scale",
      "through work or study culture",
      "through digital habits",
      "through transport and commuting",
      "through food or lifestyle",
      "through city infrastructure",
      "through things Indians assume are global"
    ],
    titleKeywords: ["India vs world"],
    descriptionKeywords: ["India comparison"],
    keywordRule: "Title must include 'India vs world'. Description must include 'India comparison'."
  },
  {
    id: "one-concept-explained",
    label: "One Concept Explained in 40 Seconds",
    prompt: `Explain one interesting concept related to India.

Additional Rules:
- Stick to one concept only.
- Make it easy to understand quickly.
- No need for visuals.

ANTI-REPETITION:
- Choose unique concepts each time.`,
    vibe: "clear, engaging",
    randomAngles: [
      "from economics",
      "from society",
      "from technology",
      "from governance",
      "from education",
      "from infrastructure",
      "from culture and behavior",
      "that most people have heard of but never understood"
    ],
    titleKeywords: ["India explained"],
    descriptionKeywords: ["India concept"],
    keywordRule: "Title must include 'India explained'. Description must include 'India concept'."
  },
  {
    id: "counterintuitive-truths-about-india",
    label: "Counterintuitive Truths About India",
    prompt: `Things about India that seem wrong but are actually true.

Additional Rules:
- Must challenge assumptions.
- Focus on logic, not visuals.
- Keep each point concise.

ANTI-REPETITION:
- Avoid common talking points.`,
    vibe: "surprising, thought-provoking",
    randomAngles: [
      "through economic logic",
      "through social behavior",
      "through population math",
      "through systems that seem broken but work oddly",
      "through city life",
      "through rural versus urban contrast",
      "through education or jobs",
      "through truths that sound fake until explained"
    ],
    titleKeywords: ["India truth"],
    descriptionKeywords: ["India facts"],
    keywordRule: "Title must include 'India truth'. Description must include 'India facts'."
  }
];

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

NARRATION PERSPECTIVE:
- Refer to India, Indians, Indian society, and Indian culture in third person.
- Never use "we", "our", or "us" to describe India or Indians unless directly quoting someone.

YOUTUBE TITLE & DESCRIPTION KEYWORDS:
- Title keywords to use: ${topic.titleKeywords.join(", ")}
- Description keywords to use: ${topic.descriptionKeywords.join(", ")}
- Rule: ${topic.keywordRule}
- The YouTube description should be long-form, CTR-optimized, and target roughly 2000+ characters. Use the description keywords naturally throughout it without obvious stuffing.`;

  if (previousFacts && previousFacts.length > 0) {
    prompt += `\n\nPREVIOUSLY USED CONTENT (do NOT reuse any of these facts, stories, or examples):\n${previousFacts.map((f, i) => `${i + 1}. ${f}`).join("\n")}`;
  }

  return { prompt: prompt, vibe: topic.vibe };
}

export function getTopicById(id: string) {
  return topicPresets.find((t) => t.id === id);
}
