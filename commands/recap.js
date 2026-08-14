const SUMMARY_PREFIX = 'Hourly Recap: ';
const TWITCH_MESSAGE_LIMIT = 500;
const SUMMARY_TEXT_LIMIT = TWITCH_MESSAGE_LIMIT - SUMMARY_PREFIX.length;

const FIRST_RECAP_DELAY = 60 * 60 * 1000;
const RECURRING_RECAP_DELAY = 60 * 60 * 1000;
const RECAP_FAILURE_RETRY_DELAY = 5 * 60 * 1000;

const RECAP_COMMAND_COOLDOWN = 5 * 60 * 1000;

const STREAM_STATUS_POLL_INTERVAL = 30 * 1000;
const TOKEN_VALIDATION_INTERVAL = 60 * 60 * 1000;

const MAX_PASTED_MESSAGES = 150;

const RECAP_EXPANSION_THRESHOLD = 380;
const RECAP_EXPANSION_MIN_MESSAGES = 20;

// ==========================================
// CHAT SANITIZATION
// ==========================================

const sensitivePatterns = [
  /\bporn(?:ography)?\b/gi,
  /\bincest\b/gi,
  /\brape(?:d|s|ing)?\b/gi,
  /\bsuicid(?:e|al)\b/gi,
  /\bbehead(?:ed|ing)?\b/gi,
  /\bdecapitat(?:e|ed|ing|ion)\b/gi
];

function sanitizeChatForGemini(chatLogs) {
  let censoredCount = 0;
  let affectedMessages = 0;

  const sanitizedLogs = chatLogs.map((chat) => {
    let sanitized = chat;
    let messageChanged = false;

    for (const pattern of sensitivePatterns) {
      sanitized = sanitized.replace(pattern, () => {
        censoredCount++;
        messageChanged = true;
        return '[censored]';
      });
    }

    if (messageChanged) {
      affectedMessages++;
    }

    return sanitized;
  });

  return {
    logs: sanitizedLogs,
    censoredCount,
    affectedMessages,
    sanitized: censoredCount > 0
  };
}

// ==========================================
// STREAM CONTEXT FORMATTER
// ==========================================

function formatStreamContext(streamContexts = []) {
  if (
    !Array.isArray(streamContexts) ||
    streamContexts.length === 0
  ) {
    return `STREAM CONTEXT:
No Twitch title/category metadata was supplied for this recap.

Do not guess the stream title, game, or category.`;
  }

  const uniqueContexts = [];

  for (const context of streamContexts) {
    const title =
      typeof context?.title === 'string'
        ? context.title.trim()
        : '';

    const category =
      typeof context?.category === 'string'
        ? context.category.trim()
        : '';

    const gameId =
      typeof context?.gameId === 'string'
        ? context.gameId.trim()
        : '';

    const previous =
      uniqueContexts[
        uniqueContexts.length - 1
      ];

    if (
      previous &&
      previous.title === title &&
      previous.category === category &&
      previous.gameId === gameId
    ) {
      continue;
    }

    uniqueContexts.push({
      title,
      category,
      gameId
    });
  }

  const lines = uniqueContexts.map(
    (context, index) => {
      const title =
        context.title || 'Unknown';

      const category =
        context.category || 'Unknown';

      return [
        `Context ${index + 1}:`,
        `- Twitch title: ${title}`,
        `- Twitch category/game: ${category}`
      ].join('\n');
    }
  );

  return `STREAM CONTEXT DURING THIS RECAP WINDOW:
${lines.join('\n\n')}

STREAM CONTEXT RULES:
- Twitch title and category/game are background metadata only.
- They may help identify the game being streamed or understand game-specific words, names, references, or terminology.
- They are NOT evidence that a specific event, action, joke, result, milestone, win, loss, encounter, or gameplay moment happened.
- Do NOT manufacture an event merely because it would make sense for the title or category.
- Chat remains the source of truth for specific things that happened or things viewers said.
- If the title/category changed during the recap window, do NOT infer exactly which chat messages belonged to which title/category unless the supplied chat itself establishes that connection.
- The order of these metadata entries only indicates that the Twitch metadata changed during the recap window.
- Do NOT use metadata changes to invent chronology between chat topics.
- If chat and stream metadata appear to conflict, preserve what chat actually says rather than forcing them to agree.`;
}

// ==========================================
// GEMINI REQUEST HELPER
// ==========================================

async function sendGeminiPrompt(prompt) {
  const apiKey =
    (process.env.GEMINI_API_KEY || '').trim();

  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY environment variable is not set.'
    );
  }

  const response = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/interactions',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify({
        model: 'gemini-3.5-flash-lite',
        input: prompt
      })
    }
  );

  let data;

  try {
    data = await response.json();
  } catch (err) {
    throw new Error(
      `Gemini returned invalid JSON. HTTP ${response.status}`
    );
  }

  if (!response.ok) {
    console.error(
      '[Gemini API Error]',
      JSON.stringify(data, null, 2)
    );

    const errorMessage =
      data?.error?.message ||
      data?.message ||
      `Gemini API returned HTTP ${response.status}`;

    const error =
      new Error(errorMessage);

    error.status = response.status;
    error.geminiData = data;

    throw error;
  }

  return data;
}

// ==========================================
// PRIMARY GEMINI RECAP REQUEST
// ==========================================

async function callGemini(
  chatLogs,
  streamContexts = []
) {
  const chatContext =
    chatLogs.join('\n');

  const streamContext =
    formatStreamContext(
      streamContexts
    );

  const customPrompt = `You are creating a factual, useful Twitch chat recap for Qwert or a viewer who was lurking, stepped away, or could not keep up with chat.

Always refer to the streamer/broadcaster as Qwert.

Your job is to tell them what was actually worth knowing from recent chat.

${streamContext}

SOURCE-OF-TRUTH RULE:
The supplied chat messages are the ONLY source of truth for specific events, actions, reactions, outcomes, jokes, viewer claims, milestones, or things that happened during the stream.

The supplied Twitch title and category/game are background metadata only.
They may help identify terminology or general game context, but they must NOT be used as proof that something happened.

Treat anything not explicitly supported by chat or explicitly stated as metadata as unknown.
Accuracy is more important than sounding polished, complete, or confident.

STRICT FACTUAL ACCURACY:
- Every factual detail about what happened must be directly supported by supplied chat.
- Never fill in missing context using assumptions, common knowledge, outside knowledge, or what you think someone probably meant.
- Never invent stream events, game events, milestones, raids, follows, subscriptions, viewer counts, follower counts, surprises, announcements, or other occurrences not explicitly supported by chat.
- Never turn speculation, jokes, guesses, predictions, or questions into established facts.
- Do not combine unrelated messages in a way that creates a new implied fact.
- Do not use the game/category to fill in a missing event.
- When uncertain, omit the detail rather than guess.

PRESERVE AMBIGUITY:
Twitch chat often uses shorthand and assumes context you may not have.
If the meaning of a number, name, pronoun, event, milestone, or reference is unclear, preserve the original ambiguity or omit it.

Example:
If someone says "you almost have 200 on Twitch," you may say "they noted Qwert is almost at 200 on Twitch."
Do NOT change it to "200 followers," "200 viewers," "200 subscribers," or another interpretation unless chat explicitly says what 200 refers to.

REFERENT AND LABEL PRESERVATION:
- Preserve the exact type of thing chat is discussing.
- Do NOT replace a vague or specific label from chat with a different, more plausible label.
- If chat says "favorites," summarize it as favorites.
- Do NOT silently change "favorites" into "team," "roster," "party," "lineup," "build," or another concept.
- If chat says "list," do not decide what kind of list it is unless chat explicitly establishes that.
- If chat says Pokémon should be added or removed from something but the destination is unclear, preserve that ambiguity.
- Pokémon names appearing together do NOT prove they are members of Qwert's active team.
- Suggestions to add, remove, replace, rank, or change Pokémon do NOT automatically mean gameplay team changes.
- Do not infer the purpose of a collection, ranking, list, group, set, favorites selection, lineup, roster, party, or box from the names involved.
- The Twitch category does NOT give permission to infer a more specific referent.
- Keep the source terminology whenever possible.
- If the exact referent cannot be determined, use neutral wording rather than guessing.
- Never upgrade an ambiguous noun into a more specific noun merely because it sounds more natural.

MESSAGE ORDER AND RECENCY:
- The supplied chat messages are ordered from older to newer within one recap window.
- Message order indicates recency, NOT a narrative timeline.
- Do NOT use words such as "later," "later on," "earlier," "afterward," "afterwards," "subsequently," "eventually," "then," or "before that" merely because one message appears after another.
- Do not imply that separate topics happened in distinct chronological phases unless chat explicitly establishes that sequence.
- Prefer neutral connectors such as "also," "while," and "and" when combining independent topics.
- Do not overuse any single transition word.
- Messages near the bottom are simply the most recent messages in the supplied chat window.

CAUSALITY RULE:
- Do NOT imply that one chat topic, stream event, joke, loss, win, comment, question, or reaction CAUSED another unless supplied chat explicitly establishes that causal relationship.
- Message proximity is NOT evidence of causation.
- Message order is NOT evidence of causation.
- Two things appearing near each other does NOT mean one prompted the other.
- Never use words or phrases such as "prompting," "which prompted," "leading to," "which led to," "causing," "resulting in," "sparking," "triggering," "in response to," "because of this," or similar causal wording unless source chat clearly supports that relationship.
- When two topics simply occurred within the same recap window, describe them independently.
- If you cannot prove from chat that A caused B, do NOT write the recap as "A happened, prompting B."
- It is acceptable for the recap to sound less narrative if that avoids inventing causality.

IMPORTANCE FILTER:
Not every chat message deserves to appear in the recap.

Prioritize details that are:
- Funny, surprising, memorable, or likely to make someone laugh.
- Clearly important to the stream or current gameplay.
- Repeated by multiple viewers.
- Part of an ongoing joke, fake command, debate, prediction, argument, or running topic.
- A notable or interesting question directed at Qwert.
- Something chat reacted strongly to.
- A clear win, loss, clutch moment, mistake, discovery, or other notable game-related reaction when chat actually supports it.
- Useful context for understanding what chat was broadly focused on.
- Sexual jokes, innuendo, suggestive fake commands, or mildly NSFW humor when they became a notable or recurring part of chat.

Deprioritize or omit:
- Routine greetings and farewells.
- Someone saying they are leaving, going to work, joining a meeting, eating, sleeping, lurking, or returning.
- Mundane personal updates that chat did not meaningfully react to.
- Isolated food, drink, product, or brand preferences unless they became a larger discussion or joke.
- Minor one-off comments with no broader relevance.
- Details that are specific but not actually interesting.
- A user's personal update simply because it is easy to summarize.

OVERALL PICTURE:
- If many messages revolve around the same broad topic, summarize that topic once instead of listing many individual comments.
- Use usernames and direct examples only for the funniest, strongest, most representative, or most useful moments.
- Balance specific highlights with a clear overall picture of what chat was mainly focused on.
- Do not turn the recap into a list of unrelated usernames and one-off comments.
- It is better to capture several meaningful themes or moments well than to mention many mundane details.
- Do not artificially connect independent topics to make the recap read like one continuous story.
- Do not improve the apparent coherence of chat by inventing labels, categories, relationships, causes, or chronology.

OPTIONAL MOOD OPENER:
- You MAY begin with one very short description of the overall chat mood if strongly supported by many messages.
- Keep it extremely short.
- Do not use a mood opener if it would crowd out useful concrete information.
- Avoid generic phrases such as "fun and lively," "good vibes," "friendly banter," "supportive atmosphere," or "chaotic vibes."
- Do not repeatedly describe chat as "chaotic."
- If the recap already makes the mood obvious, skip the opener.

PRIORITIZE CONCRETE DETAILS:
- Mention specific usernames only when their contribution is genuinely noteworthy, funny, repeated, useful, or central to a larger topic.
- Do not include a username merely because their message is easy to summarize.
- Mention specific people, games, characters, Pokémon, items, events, strategies, jokes, or fake commands when they matter.
- Capture notable opinions, disagreements, questions, predictions, suggestions, decisions, and reactions.
- Mention recurring jokes, callbacks, stream lore, or memorable comments when clearly supported by chat.
- If chat is reacting to something, describe only what the messages actually establish they are reacting to.
- Combine related comments efficiently, but do not merge unrelated comments into a new claim.
- Do not use causal wording merely as a convenient way to combine two details.
- Do not assign a specific purpose to a list of Pokémon unless chat explicitly provides that purpose.

SEXUAL / SUGGESTIVE CHAT:
- Twitch chat may include sexual jokes, innuendo, suggestive humor, horny jokes, or mildly NSFW fake commands.
- These topics MAY be included when they were funny, repeated, memorable, or meaningful.
- Do NOT erase the fact that sexual or suggestive jokes happened merely to make the recap family-friendly.
- Preserve the joke or topic when it matters.
- Paraphrase very explicit wording into milder, non-graphic language instead of repeating graphic sexual wording verbatim.
- Vary the phrasing naturally.
- Do NOT repeatedly default to the word "banter."
- Depending on context, phrases such as "suggestive jokes," "horny jokes," "NSFW humor," "chat got suggestive," "some innuendo," or a softened description of the actual joke may be more natural.
- Use "banter" only when it genuinely fits.
- Prefer describing the actual joke in softened language when that is more informative than using a generic label.
- Mild sexual wording or innuendo is acceptable when natural and useful.
- Avoid graphic descriptions of sexual acts or explicit anatomical detail.
- Do not make a harmless joke sound more serious, graphic, or explicit than source chat.
- Do not moralize about sexual humor.

AVOID VAGUE SUMMARIES:
- Do not waste space describing mood when specific useful information is available.
- Do not say "viewers discussed strategies" when the specific strategy or opinion is worth mentioning.
- Do not say "chat was joking around" when the actual joke can be briefly described.
- Avoid filler such as "friendly banter," "shared support," "good vibes," "chaos," or similar generic language.
- Do not force specificity when broader wording is more accurate.
- Do not replace source terminology with a more specific interpretation merely to make the recap sound polished.

WORDING VARIETY:
- Do not repeatedly rely on the same stock words.
- Avoid excessive use of words such as "banter," "chaos," "chaotic," "vibes," "meanwhile," "discussion," or "debate."
- Choose wording that specifically describes what chat was doing rather than generic recap language.
- Prefer concrete verbs such as "joked," "suggested," "argued," "questioned," "celebrated," "reacted," or "pitched" only when they accurately reflect the source.
- Do not force synonyms if they would change the meaning.

CENSORED CHAT:
- Some messages may contain the literal text "[censored]".
- Keep surrounding context when useful.
- Do not guess, restore, reconstruct, or repeat the censored word.
- You may still summarize the surrounding joke or topic if the remaining context clearly supports it.
- Omit the censored detail entirely when too much context is missing.

BEFORE WRITING THE RECAP:
Internally:
1. Identify the main topics and notable moments.
2. Remove mundane or low-value details.
3. Rank what remains by recap value.
4. Check every connector between topics.
5. Ask whether you implied chronology or causation that chat did not explicitly establish.
6. If yes, rewrite neutrally.
7. Check every important noun or label.
8. Ask whether chat actually identified it as a team, roster, favorites list, run, party, ranking, lineup, box, or other specific thing.
9. If you inferred the label, restore source terminology or preserve ambiguity.
10. Check whether you used stream title/category to invent a specific event.
11. If yes, remove that inference.
12. Check for repetitive stock wording such as "banter," "chaos," "vibes," or repeated "meanwhile."
13. Write the recap using only supported details.

Do not output your analysis.
Output only the final recap.

LENGTH AND COVERAGE:
- You have exactly ${SUMMARY_TEXT_LIMIT} characters available for the recap text.
- When chat contains enough supported material, target approximately 400 to ${SUMMARY_TEXT_LIMIT} characters.
- Do not stop after only one or two topics if additional noteworthy supported material exists.
- After selecting the strongest highlights, use remaining space for broader context, secondary noteworthy topics, recurring jokes, reactions, questions, or representative examples.
- Do NOT pad with mundane details merely to increase length.
- A recap under 350 characters should happen only when supplied chat genuinely lacks enough noteworthy supported material.
- NEVER exceed ${SUMMARY_TEXT_LIMIT} characters.
- Every sentence must be complete.
- Never end with "..." or an unfinished thought.
- Never begin another topic unless there is enough room to finish it.
- Prefer a dense, fuller recap using meaningful supported details.
- Do not sacrifice factual accuracy or sentence completeness to fill space.
- Never create causality or a more specific label merely to improve flow.

STYLE:
- Write 2 to 4 compact sentences when useful.
- Be information-dense but natural and readable.
- No hashtags.
- Do not start with "Hourly Recap:" because the bot adds it separately.
- Do not start with "Chat Recap:" or "AI Summary:".
- Never add assumptions, filler, inferred context, fake chronology, fake causality, or invented labels.
- Match Twitch-chat energy without becoming graphic or over-sanitized.
- Mildly cheeky wording is fine when accurately supported.
- Avoid sounding like every recap was written from the same template.
- Avoid overusing stock words such as "banter," "chaos," "vibes," and "meanwhile."

Recent Twitch chat:
${chatContext}`;

  return sendGeminiPrompt(
    customPrompt
  );
}

// ==========================================
// EXPANSION PASS
// ==========================================

async function expandRecapWithGemini({
  currentSummary,
  chatLogs,
  streamContexts = []
}) {
  const chatContext =
    chatLogs.join('\n');

  const streamContext =
    formatStreamContext(
      streamContexts
    );

  const expansionPrompt = `You are revising an existing Twitch chat recap for Qwert.

Your task is to make the recap fuller by using additional noteworthy details from the same supplied chat.

${streamContext}

CURRENT RECAP:
${currentSummary}

SOURCE CHAT:
${chatContext}

STRICT RULES:
- Supplied chat is the ONLY source for specific events, actions, reactions, results, jokes, milestones, or things that happened.
- Twitch title/category metadata is background context only.
- Never use title/category as proof that a specific event happened.
- Keep every existing factual claim accurate.
- Correct any unsupported implication in the current recap.
- Correct any invented or over-specific label in the current recap.
- Add only details directly supported by chat.
- Never invent context, events, meanings, motives, outcomes, counts, game actions, or stream events.
- Preserve ambiguity when chat is unclear.
- Never turn jokes, guesses, questions, predictions, or speculation into facts.
- Do not create fake chronology from message order or metadata changes.
- Do not restore or guess text marked "[censored]".

REFERENT AND LABEL PRESERVATION:
- Preserve the exact type of thing chat is discussing.
- If chat says "favorites," keep "favorites."
- Do NOT change "favorites" into "team," "roster," "party," "lineup," "build," or another concept.
- If chat says "list," do not invent the kind of list.
- Pokémon names appearing together do NOT prove they are an active team.
- Suggestions to add or remove Pokémon do NOT automatically mean team changes.
- Do not infer the purpose of a list, group, collection, favorites selection, ranking, roster, lineup, party, or box.
- The category/game does NOT justify replacing an ambiguous label with a gameplay-specific one.
- If the existing recap contains an inferred label, rewrite it using source terminology or preserve ambiguity.
- Broader but accurate wording is better than specific but inferred wording.

CAUSALITY RULE:
- Do NOT imply that one event, comment, joke, win, loss, question, or topic caused another unless source chat explicitly establishes that relationship.
- Message order and proximity are NOT evidence of causation.
- Never use phrases such as "prompting," "which prompted," "leading to," "which led to," "causing," "resulting in," "sparking," "triggering," "in response to," or "because of this" unless clearly supported.
- If the current recap contains unsupported causal wording, remove or rewrite it.
- Use neutral transitions for independent topics.

WHAT TO ADD:
- Additional funny or memorable moments.
- Recurring jokes or fake commands.
- Strong chat reactions.
- Notable questions directed at Qwert.
- Repeated topics.
- Interesting disagreements, opinions, predictions, or suggestions.
- Useful broader context about what chat was focused on.
- Strong representative examples.
- Sexual jokes, suggestive fake commands, innuendo, or horny humor when genuinely noteworthy.

SEXUAL / SUGGESTIVE CHAT:
- Sexual or suggestive humor does not need to be removed simply because it is NSFW.
- If recap-worthy, preserve the joke or topic.
- Paraphrase very explicit wording into milder, non-graphic language.
- Mild sexual wording and innuendo are acceptable.
- Do NOT repeatedly default to "banter."
- Prefer a softened description of the actual joke when possible.
- Avoid graphic sexual descriptions or explicit anatomical detail.
- Do not moralize or make the recap artificially family-friendly.

WORDING VARIETY:
- Avoid repetitive stock recap language.
- Do not overuse "banter," "chaos," "chaotic," "vibes," "meanwhile," "discussion," or "debate."
- Prefer concrete descriptions when supported.
- Do not introduce unsupported meaning just to vary wording.

DO NOT ADD:
- Routine greetings.
- Farewells.
- Mundane personal updates.
- Someone simply leaving for work, eating, sleeping, lurking, returning, or joining a meeting.
- Random food, drink, or product preferences unless they became an actual discussion or joke.
- Weak one-off comments merely to increase length.
- Generic filler.
- Unsupported narrative links.
- More-specific nouns or labels than source chat supports.
- Events inferred only from title/category.

LENGTH:
- Target between 400 and ${SUMMARY_TEXT_LIMIT} characters total.
- Use as much available space as reasonably possible when enough noteworthy material exists.
- Do not exceed ${SUMMARY_TEXT_LIMIT} characters.
- Every sentence must be complete.
- Never end with "...".
- If source chat genuinely does not contain enough worthwhile material to reach 400 characters, remain shorter rather than inventing or padding.

STYLE:
- 2 to 4 compact sentences.
- Dense, natural, readable.
- Keep the strongest existing points.
- Add worthwhile secondary context.
- Match Twitch-chat energy.
- Mildly cheeky or suggestive phrasing is acceptable when supported.
- Do not become graphic.
- Prefer source terminology over inferred terminology.
- Avoid sounding templated.
- Do not start with "Hourly Recap:", "Chat Recap:", or "AI Summary:".

Before outputting the revised recap, silently check:
1. Did I imply unsupported causation?
2. Did I invent chronology?
3. Did I replace a source label with a more specific one?
4. Did I use Twitch metadata as evidence that an event happened?
5. Did I associate a message with a particular category change without evidence?
6. Did I unnecessarily use stock wording such as "banter," "chaos," "vibes," or "meanwhile"?
7. If any answer is yes, correct it.

Output ONLY the revised recap.`;

  return sendGeminiPrompt(
    expansionPrompt
  );
}

// ==========================================
// EXTRACT GEMINI RESPONSE
// ==========================================

function extractGeminiText(data) {
  let summary = '';

  if (Array.isArray(data.steps)) {
    for (const step of data.steps) {
      if (
        step?.type !== 'model_output' ||
        !Array.isArray(step.content)
      ) {
        continue;
      }

      for (const item of step.content) {
        if (
          item?.type === 'text' &&
          typeof item.text === 'string' &&
          item.text.trim()
        ) {
          summary += `${item.text} `;
        }
      }
    }
  }

  if (
    !summary &&
    typeof data.output_text === 'string'
  ) {
    summary =
      data.output_text;
  }

  if (
    !summary &&
    typeof data.outputText === 'string'
  ) {
    summary =
      data.outputText;
  }

  if (
    !summary &&
    typeof data.text === 'string'
  ) {
    summary =
      data.text;
  }

  if (
    !summary &&
    Array.isArray(data.outputs)
  ) {
    for (const output of data.outputs) {
      if (
        typeof output?.text === 'string'
      ) {
        summary +=
          `${output.text} `;
      }
    }
  }

  return summary.trim();
}

// ==========================================
// CLEAN RECAP WORDING
// ==========================================

function cleanRecapWording(summary) {
  return summary
    .replace(
      /\bLater on,\s*/gi,
      'Also, '
    )
    .replace(
      /\bLater,\s*/gi,
      'Also, '
    )
    .replace(
      /\bAfterward,\s*/gi,
      'Also, '
    )
    .replace(
      /\bAfterwards,\s*/gi,
      'Also, '
    )
    .replace(
      /\bSubsequently,\s*/gi,
      'Also, '
    )
    .replace(
      /\bEventually,\s*/gi,
      'Also, '
    )
    .replace(
      /\bThen,\s*/gi,
      'Also, '
    )
    .replace(
      /\bBefore that,\s*/gi,
      'Also, '
    )
    .replace(
      /,\s*prompting\s+(?:chat|viewers|members)\s+to\s+/gi,
      '. Chat also '
    )
    .replace(
      /,\s*which prompted\s+(?:chat|viewers|members)\s+to\s+/gi,
      '. Chat also '
    )
    .replace(
      /,\s*leading\s+(?:chat|viewers|members)\s+to\s+/gi,
      '. Chat also '
    )
    .replace(
      /,\s*which led\s+(?:chat|viewers|members)\s+to\s+/gi,
      '. Chat also '
    )
    .replace(
      /,\s*causing\s+(?:chat|viewers|members)\s+to\s+/gi,
      '. Chat also '
    )
    .replace(
      /,\s*resulting in\s+/gi,
      '. Also, '
    )
    .replace(
      /,\s*sparking\s+/gi,
      '. Also, '
    )
    .replace(
      /,\s*triggering\s+/gi,
      '. Also, '
    )
    .replace(
      /\bAlso,\s+also\b/gi,
      'Also'
    )
    .replace(
      /\.\s+also,\s+/gi,
      '. Also, '
    )
    .replace(
      /\s{2,}/g,
      ' '
    )
    .trim();
}

function cleanRecapPrefixes(summary) {
  return summary
    .replace(
      /^AI Summary:\s*/i,
      ''
    )
    .replace(
      /^Chat Recap:\s*/i,
      ''
    )
    .replace(
      /^Hourly Recap:\s*/i,
      ''
    )
    .trim();
}

function removeTrailingEllipsis(summary) {
  if (!/\.{3}\s*$/.test(summary)) {
    return summary;
  }

  const withoutEllipsis =
    summary.replace(
      /\s*\.{3}\s*$/,
      ''
    );

  const lastSentenceEnd =
    Math.max(
      withoutEllipsis.lastIndexOf('.'),
      withoutEllipsis.lastIndexOf('?'),
      withoutEllipsis.lastIndexOf('!')
    );

  if (lastSentenceEnd >= 0) {
    return withoutEllipsis
      .substring(
        0,
        lastSentenceEnd + 1
      )
      .trim();
  }

  return withoutEllipsis.trim();
}

// ==========================================
// SAFE COMPLETE-SENTENCE LIMIT
// ==========================================

function enforceSummaryLimit(summary) {
  if (
    summary.length <=
    SUMMARY_TEXT_LIMIT
  ) {
    return summary;
  }

  const withinLimit =
    summary.substring(
      0,
      SUMMARY_TEXT_LIMIT
    );

  const lastSentenceEnd =
    Math.max(
      withinLimit.lastIndexOf('.'),
      withinLimit.lastIndexOf('?'),
      withinLimit.lastIndexOf('!')
    );

  if (lastSentenceEnd >= 0) {
    return withinLimit
      .substring(
        0,
        lastSentenceEnd + 1
      )
      .trim();
  }

  const lastSpace =
    withinLimit.lastIndexOf(' ');

  if (lastSpace > 0) {
    return withinLimit
      .substring(
        0,
        lastSpace
      )
      .trim();
  }

  return withinLimit.trim();
}

function normalizeRecap(summary) {
  let cleaned =
    cleanRecapPrefixes(summary);

  cleaned =
    cleanRecapWording(cleaned);

  cleaned =
    removeTrailingEllipsis(cleaned);

  cleaned =
    enforceSummaryLimit(cleaned);

  return cleaned;
}

function isGeminiInputBlocked(err) {
  const message =
    (err?.message || '')
      .toLowerCase();

  return (
    message.includes('input blocked') ||
    message.includes('sensitive words') ||
    message.includes('prohibited use policy') ||
    message.includes('blocked the chat input')
  );
}

// ==========================================
// GENERATE RECAP
// ==========================================

async function generateRecap(
  chatLogs,
  streamContexts = []
) {
  if (
    !Array.isArray(chatLogs) ||
    chatLogs.length === 0
  ) {
    throw new Error(
      'No chat logs were provided to Gemini.'
    );
  }

  const sanitization =
    sanitizeChatForGemini(
      chatLogs
    );

  if (sanitization.sanitized) {
    console.log(
      `[Gemini] Sanitized ${sanitization.censoredCount} sensitive term(s) across ` +
      `${sanitization.affectedMessages} message(s).`
    );
  }

  let primaryData;

  try {
    primaryData =
      await callGemini(
        sanitization.logs,
        streamContexts
      );
  } catch (err) {
    if (
      isGeminiInputBlocked(err)
    ) {
      const blockedError =
        new Error(
          'Gemini blocked the chat input even after sensitive-term redaction.'
        );

      blockedError.inputBlocked = true;
      blockedError.sanitization =
        sanitization;

      throw blockedError;
    }

    throw err;
  }

  let summary =
    extractGeminiText(
      primaryData
    );

  if (!summary) {
    console.error(
      '[Gemini Unexpected Response]',
      JSON.stringify(
        primaryData,
        null,
        2
      )
    );

    throw new Error(
      'Gemini returned a successful response but no readable text output was found.'
    );
  }

  summary =
    normalizeRecap(summary);

  console.log(
    '[Gemini Primary Recap]',
    summary
  );

  console.log(
    `[Gemini Primary Length] ${summary.length}/${SUMMARY_TEXT_LIMIT}`
  );

  const shouldExpand =
    summary.length <
      RECAP_EXPANSION_THRESHOLD &&
    sanitization.logs.length >=
      RECAP_EXPANSION_MIN_MESSAGES;

  if (shouldExpand) {
    console.log(
      `[Gemini] Recap is under ${RECAP_EXPANSION_THRESHOLD} chars with ${sanitization.logs.length} source messages. Running expansion pass.`
    );

    try {
      const expansionData =
        await expandRecapWithGemini({
          currentSummary: summary,
          chatLogs:
            sanitization.logs,
          streamContexts
        });

      let expandedSummary =
        extractGeminiText(
          expansionData
        );

      if (expandedSummary) {
        expandedSummary =
          normalizeRecap(
            expandedSummary
          );

        console.log(
          '[Gemini Expanded Recap]',
          expandedSummary
        );

        console.log(
          `[Gemini Expanded Length] ${expandedSummary.length}/${SUMMARY_TEXT_LIMIT}`
        );

        if (
          expandedSummary.length >
          summary.length
        ) {
          summary =
            expandedSummary;

          console.log(
            '[Gemini] Expanded recap selected.'
          );
        } else {
          console.log(
            '[Gemini] Expansion was not longer. Keeping primary recap.'
          );
        }
      } else {
        console.log(
          '[Gemini] Expansion returned no readable text. Keeping primary recap.'
        );
      }
    } catch (err) {
      console.error(
        '[Gemini Expansion Error]',
        err
      );

      console.log(
        '[Gemini] Keeping primary recap because expansion failed.'
      );
    }
  }

  summary =
    enforceSummaryLimit(
      summary
    );

  console.log(
    '[Gemini Final Recap]',
    summary
  );

  console.log(
    `[Gemini Final Length] ${summary.length}/${SUMMARY_TEXT_LIMIT}`
  );

  return {
    summary,
    sanitization
  };
}

// ==========================================
// PARSE PASTED RENDER LOGS
// ==========================================

function parsePastedChat(
  rawText,
  ignoredUsernames = []
) {
  if (
    typeof rawText !== 'string' ||
    !rawText.trim()
  ) {
    return {
      logs: [],
      totalValidMessages: 0,
      truncated: false
    };
  }

  const ignored =
    ignoredUsernames
      .filter(Boolean)
      .map((name) =>
        name
          .toLowerCase()
          .trim()
      );

  const lines =
    rawText
      .split(/\r?\n/)
      .map((line) =>
        line.trim()
      )
      .filter(Boolean);

  const parsedMessages = [];

  for (
    const originalLine
    of lines
  ) {
    const line =
      originalLine
        .replace(
          /\x1B\[[0-9;]*[A-Za-z]/g,
          ''
        )
        .trim();

    let username = '';
    let message = '';
    let match;

    match = line.match(
      /<([A-Za-z0-9_]{1,25})>\s*:?\s*(.+)$/
    );

    if (match) {
      username = match[1];
      message = match[2];
    }

    if (!username) {
      match = line.match(
        /^([A-Za-z0-9_]{1,25}):\s*(.+)$/
      );

      if (match) {
        username = match[1];
        message = match[2];
      }
    }

    if (!username) {
      match = line.match(
        /\[[^\]]+\]\s+([A-Za-z0-9_]{1,25}):\s*(.+)$/
      );

      if (match) {
        username = match[1];
        message = match[2];
      }
    }

    if (
      !username ||
      !message
    ) {
      continue;
    }

    if (
      ignored.includes(
        username.toLowerCase()
      )
    ) {
      continue;
    }

    message =
      message.trim();

    if (!message) {
      continue;
    }

    parsedMessages.push(
      `${username}: ${message}`
    );
  }

  const totalValidMessages =
    parsedMessages.length;

  return {
    logs:
      parsedMessages.slice(
        -MAX_PASTED_MESSAGES
      ),

    totalValidMessages,

    truncated:
      totalValidMessages >
      MAX_PASTED_MESSAGES
  };
}

// ==========================================
// COUNTDOWN FORMATTER
// ==========================================

function formatCountdown(
  milliseconds
) {
  const totalSeconds =
    Math.max(
      0,
      Math.ceil(
        milliseconds / 1000
      )
    );

  const minutes =
    Math.floor(
      totalSeconds / 60
    );

  const seconds =
    totalSeconds % 60;

  if (minutes > 0) {
    return `${minutes}min ${seconds}s`;
  }

  return `${seconds}s`;
}

// ==========================================
// AUTOMATIC RECAP MANAGER
// ==========================================

function createRecapManager({
  client,
  channelName,
  botUsername,
  twitchAccessToken
}) {
  const accessToken =
    (twitchAccessToken || '')
      .replace(
        /^oauth:/i,
        ''
      )
      .trim();

  let twitchClientId = '';

  let streamStateInitialized =
    false;

  let streamLive =
    false;

  let currentStreamTitle =
    '';

  let currentStreamCategory =
    '';

  let currentStreamGameId =
    '';

  let recapMessages =
    [];

  let messageSequence =
    0;

  let streamContexts =
    [];

  let contextSequence =
    0;

  let firstRecapSent =
    false;

  let recapInProgress =
    false;

  let streamSessionStartedAt =
    0;

  let nextRecapAt =
    0;

  let recapPaused =
    false;

  let pausedRemainingMs =
    0;

  let recapTimer =
    null;

  let streamPollTimer =
    null;

  let tokenValidationTimer =
    null;

  let lastRecapCommandUse =
    0;

  function addStreamContext({
    title = '',
    category = '',
    gameId = ''
  }) {
    const cleanTitle =
      String(title || '').trim();

    const cleanCategory =
      String(category || '').trim();

    const cleanGameId =
      String(gameId || '').trim();

    const lastContext =
      streamContexts[
        streamContexts.length - 1
      ];

    if (
      lastContext &&
      lastContext.title === cleanTitle &&
      lastContext.category === cleanCategory &&
      lastContext.gameId === cleanGameId
    ) {
      return;
    }

    contextSequence++;

    streamContexts.push({
      id: contextSequence,
      timestamp: Date.now(),
      title: cleanTitle,
      category: cleanCategory,
      gameId: cleanGameId
    });

    console.log(
      '[Recap] Stream context recorded:',
      {
        title:
          cleanTitle || 'Unknown',
        category:
          cleanCategory || 'Unknown'
      }
    );
  }

  function updateCurrentStreamContext(
    status
  ) {
    const newTitle =
      String(
        status?.title || ''
      ).trim();

    const newCategory =
      String(
        status?.category || ''
      ).trim();

    const newGameId =
      String(
        status?.gameId || ''
      ).trim();

    const changed =
      newTitle !==
        currentStreamTitle ||
      newCategory !==
        currentStreamCategory ||
      newGameId !==
        currentStreamGameId;

    currentStreamTitle =
      newTitle;

    currentStreamCategory =
      newCategory;

    currentStreamGameId =
      newGameId;

    if (
      changed &&
      streamLive &&
      !recapPaused
    ) {
      addStreamContext({
        title:
          currentStreamTitle,
        category:
          currentStreamCategory,
        gameId:
          currentStreamGameId
      });
    }
  }

  async function validateTwitchToken() {
    if (!accessToken) {
      throw new Error(
        'TWITCH_BOT_ACCESS_TOKEN is missing.'
      );
    }

    const response =
      await fetch(
        'https://id.twitch.tv/oauth2/validate',
        {
          headers: {
            Authorization:
              `Bearer ${accessToken}`
          }
        }
      );

    if (!response.ok) {
      throw new Error(
        `Twitch token validation failed with HTTP ${response.status}.`
      );
    }

    const data =
      await response.json();

    if (!data.client_id) {
      throw new Error(
        'Twitch token validation did not return a Client ID.'
      );
    }

    twitchClientId =
      data.client_id;

    console.log(
      '[Recap] Twitch OAuth token validated.'
    );

    return data;
  }

  async function fetchStreamStatus(
    allowRetry = true
  ) {
    if (!twitchClientId) {
      await validateTwitchToken();
    }

    const url =
      'https://api.twitch.tv/helix/streams?' +
      new URLSearchParams({
        user_login:
          channelName
      }).toString();

    const response =
      await fetch(
        url,
        {
          headers: {
            Authorization:
              `Bearer ${accessToken}`,
            'Client-Id':
              twitchClientId
          }
        }
      );

    if (
      response.status === 401 &&
      allowRetry
    ) {
      console.warn(
        '[Recap] Twitch API returned 401. Revalidating token.'
      );

      await validateTwitchToken();

      return fetchStreamStatus(
        false
      );
    }

    if (!response.ok) {
      throw new Error(
        `Twitch stream-status request failed with HTTP ${response.status}.`
      );
    }

    const data =
      await response.json();

    const stream =
      Array.isArray(data.data) &&
      data.data.length > 0
        ? data.data[0]
        : null;

    return {
      live:
        Boolean(stream),

      startedAt:
        stream?.started_at ||
        null,

      title:
        stream?.title ||
        '',

      category:
        stream?.game_name ||
        '',

      gameId:
        stream?.game_id ||
        ''
    };
  }

  function clearRecapTimer() {
    if (recapTimer) {
      clearTimeout(
        recapTimer
      );

      recapTimer =
        null;
    }
  }

  function scheduleRecapAt(
    timestamp
  ) {
    clearRecapTimer();

    if (recapPaused) {
      return;
    }

    nextRecapAt =
      timestamp;

    const delay =
      Math.max(
        0,
        timestamp -
        Date.now()
      );

    recapTimer =
      setTimeout(
        () => {
          sendAutomaticRecap(
            firstRecapSent
              ? '60-minute timer'
              : 'first 60-minute timer'
          ).catch((err) => {
            console.error(
              '[Recap] Scheduled recap error:',
              err
            );
          });
        },
        delay
      );
  }

  function startStreamSession(
    status,
    alreadyLiveAtStartup = false
  ) {
    clearRecapTimer();

    streamLive =
      true;

    recapMessages =
      [];

    messageSequence =
      0;

    streamContexts =
      [];

    contextSequence =
      0;

    firstRecapSent =
      false;

    recapInProgress =
      false;

    recapPaused =
      false;

    pausedRemainingMs =
      0;

    currentStreamTitle =
      String(
        status?.title || ''
      ).trim();

    currentStreamCategory =
      String(
        status?.category || ''
      ).trim();

    currentStreamGameId =
      String(
        status?.gameId || ''
      ).trim();

    if (
      status?.startedAt &&
      !alreadyLiveAtStartup
    ) {
      const parsed =
        Date.parse(
          status.startedAt
        );

      streamSessionStartedAt =
        Number.isNaN(parsed)
          ? Date.now()
          : parsed;
    } else {
      streamSessionStartedAt =
        Date.now();
    }

    addStreamContext({
      title:
        currentStreamTitle,
      category:
        currentStreamCategory,
      gameId:
        currentStreamGameId
    });

    nextRecapAt =
      streamSessionStartedAt +
      FIRST_RECAP_DELAY;

    scheduleRecapAt(
      nextRecapAt
    );

    console.log(
      '[Recap] Qwert is LIVE. Automatic recap session started.'
    );

    console.log(
      '[Recap] Current stream title:',
      currentStreamTitle ||
        'Unknown'
    );

    console.log(
      '[Recap] Current category:',
      currentStreamCategory ||
        'Unknown'
    );

    console.log(
      '[Recap] First recap will send after 60 minutes.'
    );
  }

  function endStreamSession() {
    clearRecapTimer();

    streamLive =
      false;

    currentStreamTitle =
      '';

    currentStreamCategory =
      '';

    currentStreamGameId =
      '';

    recapMessages =
      [];

    messageSequence =
      0;

    streamContexts =
      [];

    contextSequence =
      0;

    firstRecapSent =
      false;

    recapInProgress =
      false;

    recapPaused =
      false;

    pausedRemainingMs =
      0;

    streamSessionStartedAt =
      0;

    nextRecapAt =
      0;

    console.log(
      '[Recap] Qwert is OFFLINE. Automatic recap session stopped and recap history cleared.'
    );
  }

  async function checkStreamStatus() {
    try {
      const status =
        await fetchStreamStatus();

      if (
        !streamStateInitialized
      ) {
        streamStateInitialized =
          true;

        if (status.live) {
          startStreamSession(
            status,
            true
          );
        } else {
          streamLive =
            false;

          console.log(
            '[Recap] Qwert is currently offline. Waiting for stream start.'
          );
        }

        return;
      }

      if (
        status.live &&
        !streamLive
      ) {
        startStreamSession(
          status,
          false
        );

        return;
      }

      if (
        !status.live &&
        streamLive
      ) {
        endStreamSession();
        return;
      }

      if (
        status.live &&
        streamLive
      ) {
        updateCurrentStreamContext(
          status
        );
      }
    } catch (err) {
      console.error(
        '[Recap] Stream status check failed:',
        err
      );
    }
  }

  async function stopRecap({
    channel,
    displayName = 'MOD',
    announce = true
  }) {
    if (!streamLive) {
      if (announce) {
        await client.say(
          channel,
          `@${displayName}, Qwert is offline, so the recap system is already inactive.`
        );
      }

      return {
        success: false,
        message:
          'Qwert is offline.'
      };
    }

    if (recapPaused) {
      if (announce) {
        await client.say(
          channel,
          `@${displayName}, automatic hourly recaps are already paused.`
        );
      }

      return {
        success: false,
        message:
          'Automatic hourly recaps are already paused.'
      };
    }

    if (recapInProgress) {
      if (announce) {
        await client.say(
          channel,
          `@${displayName}, an hourly recap is already being generated, so it can't be paused right now.`
        );
      }

      return {
        success: false,
        message:
          'An hourly recap is currently being generated.'
      };
    }

    pausedRemainingMs =
      nextRecapAt
        ? Math.max(
            0,
            nextRecapAt -
              Date.now()
          )
        : 0;

    recapPaused =
      true;

    clearRecapTimer();

    console.log(
      `[Recap] Paused by ${displayName}.`
    );

    console.log(
      `[Recap] ${recapMessages.length} messages preserved.`
    );

    console.log(
      `[Recap] ${formatCountdown(pausedRemainingMs)} remaining on timer.`
    );

    if (announce) {
      await client.say(
        channel,
        `@${displayName}, automatic hourly recaps are paused. ${recapMessages.length} messages are preserved and the timer is frozen with ${formatCountdown(pausedRemainingMs)} remaining.`
      );
    }

    return {
      success: true,
      message:
        `Automatic hourly recaps paused with ${formatCountdown(pausedRemainingMs)} remaining.`
    };
  }

  async function startRecap({
    channel,
    displayName = 'MOD',
    announce = true
  }) {
    if (!streamLive) {
      if (announce) {
        await client.say(
          channel,
          `@${displayName}, Qwert is offline. Hourly recaps will start fresh when the next stream begins.`
        );
      }

      return {
        success: false,
        message:
          'Qwert is offline.'
      };
    }

    if (!recapPaused) {
      if (announce) {
        await client.say(
          channel,
          `@${displayName}, automatic hourly recaps are already running.`
        );
      }

      return {
        success: false,
        message:
          'Automatic hourly recaps are already running.'
      };
    }

    recapPaused =
      false;

    const resumeDelay =
      Math.max(
        1000,
        pausedRemainingMs
      );

    nextRecapAt =
      Date.now() +
      resumeDelay;

    pausedRemainingMs =
      0;

    addStreamContext({
      title:
        currentStreamTitle,
      category:
        currentStreamCategory,
      gameId:
        currentStreamGameId
    });

    scheduleRecapAt(
      nextRecapAt
    );

    console.log(
      `[Recap] Resumed by ${displayName}.`
    );

    console.log(
      `[Recap] ${recapMessages.length} preserved messages remain in the active window.`
    );

    console.log(
      `[Recap] Next recap in ${formatCountdown(resumeDelay)}.`
    );

    if (announce) {
      await client.say(
        channel,
        `@${displayName}, automatic hourly recaps resumed where they left off. Next recap in ${formatCountdown(resumeDelay)}.`
      );
    }

    return {
      success: true,
      message:
        `Automatic hourly recaps resumed. Next recap in ${formatCountdown(resumeDelay)}.`
    };
  }

  function recordChatMessage({
    displayName,
    rawMessage
  }) {
    if (
      !streamLive ||
      recapPaused
    ) {
      return;
    }

    const text =
      (rawMessage || '')
        .trim();

    if (!text) {
      return;
    }

    messageSequence++;

    recapMessages.push({
      id:
        messageSequence,

      timestamp:
        Date.now(),

      text:
        `${displayName}: ${text}`
    });
  }

  function discardMessageSnapshot(
    snapshotMaxId
  ) {
    if (
      snapshotMaxId === null
    ) {
      return;
    }

    recapMessages =
      recapMessages.filter(
        (item) =>
          item.id >
          snapshotMaxId
      );
  }

  function discardContextSnapshot(
    snapshotMaxContextId
  ) {
    if (
      snapshotMaxContextId ===
      null
    ) {
      return;
    }

    streamContexts =
      streamContexts.filter(
        (item) =>
          item.id >
          snapshotMaxContextId
      );

    if (
      streamContexts.length === 0 &&
      streamLive
    ) {
      addStreamContext({
        title:
          currentStreamTitle,
        category:
          currentStreamCategory,
        gameId:
          currentStreamGameId
      });
    }
  }

  async function sendAutomaticRecap(
    reason
  ) {
    if (
      !streamLive ||
      recapPaused ||
      recapInProgress
    ) {
      return;
    }

    recapInProgress =
      true;

    clearRecapTimer();

    const messageSnapshot =
      [...recapMessages];

    const contextSnapshot =
      [...streamContexts];

    const snapshotMaxId =
      messageSnapshot.length > 0
        ? messageSnapshot[
            messageSnapshot.length - 1
          ].id
        : null;

    const snapshotMaxContextId =
      contextSnapshot.length > 0
        ? contextSnapshot[
            contextSnapshot.length - 1
          ].id
        : null;

    const chatLogs =
      messageSnapshot.map(
        (item) =>
          item.text
      );

    console.log(
      `[Recap] Automatic recap triggered by ${reason}.`
    );

    console.log(
      `[Recap] Window contains ${chatLogs.length} chat messages.`
    );

    console.log(
      `[Recap] Window contains ${contextSnapshot.length} stream context entr${contextSnapshot.length === 1 ? 'y' : 'ies'}.`
    );

    try {
      let twitchMessage;

      if (
        chatLogs.length === 0
      ) {
        twitchMessage =
          SUMMARY_PREFIX +
          'Chat was quiet this hour—nothing notable to recap.';
      } else {
        const result =
          await generateRecap(
            chatLogs,
            contextSnapshot
          );

        twitchMessage =
          SUMMARY_PREFIX +
          result.summary;
      }

      if (!streamLive) {
        console.log(
          '[Recap] Stream ended during recap generation. Recap was not sent.'
        );

        recapInProgress =
          false;

        return;
      }

      await client.say(
        channelName,
        twitchMessage
      );

      console.log(
        '[Recap] Sent:',
        twitchMessage
      );

      console.log(
        `[Recap] Length: ${twitchMessage.length}/500`
      );

      discardMessageSnapshot(
        snapshotMaxId
      );

      discardContextSnapshot(
        snapshotMaxContextId
      );

      firstRecapSent =
        true;

      recapInProgress =
        false;

      nextRecapAt =
        Date.now() +
        RECURRING_RECAP_DELAY;

      scheduleRecapAt(
        nextRecapAt
      );

      console.log(
        '[Recap] Previous recap messages and stream context marked as used.'
      );

      console.log(
        '[Recap] Next automatic recap scheduled in 60 minutes.'
      );
    } catch (err) {
      console.error(
        '[Recap] Automatic recap failed:',
        err
      );

      if (err.inputBlocked) {
        recapInProgress =
          false;

        discardMessageSnapshot(
          snapshotMaxId
        );

        discardContextSnapshot(
          snapshotMaxContextId
        );

        firstRecapSent =
          true;

        if (streamLive) {
          try {
            await client.say(
              channelName,
              "The hourly recap was blocked due to sensitive terms found in chat. I'll try again in 60 minutes. Y'all may have gone a little too hard for the robot. LUL"
            );
          } catch (sendErr) {
            console.error(
              '[Recap] Failed to send blocked-recap notice:',
              sendErr
            );
          }

          nextRecapAt =
            Date.now() +
            RECURRING_RECAP_DELAY;

          scheduleRecapAt(
            nextRecapAt
          );

          console.log(
            '[Recap] Blocked recap window discarded.'
          );

          console.log(
            '[Recap] Fresh recap window started. Next attempt in 60 minutes.'
          );
        }

        return;
      }

      recapInProgress =
        false;

      nextRecapAt =
        Date.now() +
        RECAP_FAILURE_RETRY_DELAY;

      scheduleRecapAt(
        nextRecapAt
      );

      console.log(
        '[Recap] Retrying automatic recap in 5 minutes.'
      );
    }
  }

  async function handleRecapCommand({
    channel,
    displayName
  }) {
    const now =
      Date.now();

    const elapsed =
      now -
      lastRecapCommandUse;

    if (
      lastRecapCommandUse > 0 &&
      elapsed <
        RECAP_COMMAND_COOLDOWN
    ) {
      const remaining =
        RECAP_COMMAND_COOLDOWN -
        elapsed;

      await client.say(
        channel,
        `@${displayName}, !recap is on cooldown! Try again in ${formatCountdown(remaining)}.`
      );

      return;
    }

    lastRecapCommandUse =
      now;

    try {
      if (!streamLive) {
        await client.say(
          channel,
          `@${displayName}, hourly recaps will start when Qwert goes live.`
        );

        return;
      }

      if (recapPaused) {
        await client.say(
          channel,
          `@${displayName}, automatic hourly recaps are currently paused by a moderator.`
        );

        return;
      }

      if (recapInProgress) {
        await client.say(
          channel,
          `@${displayName}, the next hourly recap is being generated now.`
        );

        return;
      }

      if (!nextRecapAt) {
        await client.say(
          channel,
          `@${displayName}, the hourly recap timer is starting now.`
        );

        return;
      }

      const timeRemaining =
        formatCountdown(
          nextRecapAt -
          Date.now()
        );

      await client.say(
        channel,
        `@${displayName}, the next hourly recap will be sent in ${timeRemaining}.`
      );
    } catch (err) {
      console.error(
        '[Recap] Failed to answer !recap:',
        err
      );
    }
  }

  function getStatus() {
    return {
      streamStateInitialized,
      streamLive,

      currentStreamTitle:
        currentStreamTitle ||
        null,

      currentStreamCategory:
        currentStreamCategory ||
        null,

      currentStreamGameId:
        currentStreamGameId ||
        null,

      recapPaused,

      loggingMessages:
        streamStateInitialized &&
        streamLive &&
        !recapPaused,

      recapInProgress,
      firstRecapSent,

      messagesInWindow:
        recapMessages.length,

      contextChangesInWindow:
        streamContexts.length,

      nextRecapAt:
        recapPaused
          ? null
          : nextRecapAt ||
            null,

      pausedRemainingMs:
        recapPaused
          ? pausedRemainingMs
          : null,

      streamSessionStartedAt:
        streamSessionStartedAt ||
        null
    };
  }

  function getCurrentWindowLogs() {
    return recapMessages.map(
      (item) =>
        item.text
    );
  }

  function getCurrentWindowContexts() {
    return streamContexts.map(
      (item) => ({
        title:
          item.title,
        category:
          item.category,
        gameId:
          item.gameId
      })
    );
  }

  async function start() {
    if (
      !channelName ||
      !accessToken
    ) {
      console.error(
        '[Recap] Cannot start automatic recaps: Twitch configuration is incomplete.'
      );

      return;
    }

    try {
      await validateTwitchToken();
    } catch (err) {
      console.error(
        '[Recap] Initial Twitch token validation failed:',
        err
      );

      return;
    }

    await checkStreamStatus();

    streamPollTimer =
      setInterval(
        checkStreamStatus,
        STREAM_STATUS_POLL_INTERVAL
      );

    tokenValidationTimer =
      setInterval(
        () => {
          validateTwitchToken()
            .catch((err) => {
              console.error(
                '[Recap] Hourly Twitch token validation failed:',
                err
              );
            });
        },
        TOKEN_VALIDATION_INTERVAL
      );

    console.log(
      '[Recap] Automatic stream detection enabled.'
    );

    console.log(
      '[Recap] Twitch stream status/title/category will be checked every 30 seconds.'
    );

    console.log(
      '[Recap] Automatic recap cadence: every 60 minutes.'
    );
  }

  return {
    start,
    recordChatMessage,
    handleRecapCommand,
    stopRecap,
    startRecap,
    getCurrentWindowLogs,
    getCurrentWindowContexts,
    getStatus
  };
}

// ==========================================
// EXPORTS
// ==========================================

module.exports = {
  createRecapManager,
  generateRecap,
  parsePastedChat,
  SUMMARY_PREFIX,
  TWITCH_MESSAGE_LIMIT,
  SUMMARY_TEXT_LIMIT,
  MAX_PASTED_MESSAGES
};
