// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

export const PDF_TITLE = "Why plants are green";

/** A page of a teacher's handout, a sentence a line; written for this guide. */
const LINES = [
  "Why plants are green",
  "",
  "Plants make their own food through photosynthesis.",
  "Leaves take in carbon dioxide from the air, and roots take up water from the soil.",
  "Chlorophyll is the green pigment in leaves.",
  "It captures energy from sunlight.",
  "Plants look green because chlorophyll reflects green light.",
  "The plant uses that energy to turn water and carbon dioxide into glucose.",
  "Glucose is a sugar the plant uses as food.",
  "Oxygen is released into the air as a by-product.",
  "Animals, including people, breathe the oxygen that plants release.",
];

/** One A4 page of real text, so the console reads it without AI (sources-22). */
export function handoutPdf(): Uint8Array {
  const escape = (line: string) => line.replace(/[\\()]/g, (c) => `\\${c}`);
  const text = LINES.map((line, index) => {
    const size = index === 0 ? 20 : 12;
    return `BT /F1 ${size} Tf 56 ${770 - index * 26} Td (${escape(line)}) Tj ET`;
  }).join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((body, index) => {
    const offset = pdf.length;
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

const quote = {
  food: "Plants make their own food through photosynthesis.",
  inputs: "Leaves take in carbon dioxide from the air, and roots take up water from the soil.",
  pigment: "Chlorophyll is the green pigment in leaves.",
  green: "Plants look green because chlorophyll reflects green light.",
  glucose: "The plant uses that energy to turn water and carbon dioxide into glucose.",
  oxygen: "Oxygen is released into the air as a by-product.",
};

/**
 * What the model would answer, in the shape it is asked for; every quote is in
 * the handout. The first question is typed: a learner sees it first, and its
 * picture has no options, whose order is shuffled differently in every run.
 */
export const DRAFT = {
  objectives: [
    {
      title: "Explain why plants look green",
      quotes: [quote.pigment, quote.green],
      tasks: [
        {
          kind: "typed",
          prompt: "What is the green pigment in leaves called?",
          accepted: ["chlorophyll"],
          answerLanguage: "en",
          explanation: "Chlorophyll is the green pigment in leaves.",
          quotes: [quote.pigment],
        },
        {
          kind: "choice",
          prompt: "Why do plants look green?",
          options: [
            "Chlorophyll reflects green light",
            "Roots take up green water",
            "Oxygen is green",
          ],
          answer: 0,
          explanation: "Chlorophyll, the green pigment in leaves, reflects green light.",
          quotes: [quote.green],
        },
      ],
    },
    {
      title: "Name what photosynthesis takes in and gives out",
      quotes: [quote.food, quote.inputs, quote.glucose, quote.oxygen],
      tasks: [
        {
          kind: "choice",
          prompt: "What do leaves take in from the air?",
          options: ["Carbon dioxide", "Glucose", "Water"],
          answer: 0,
          explanation: "Leaves take in carbon dioxide from the air; roots take up water.",
          quotes: [quote.inputs],
        },
        {
          kind: "choice",
          prompt: "What is released into the air as a by-product?",
          options: ["Oxygen", "Sugar", "Chlorophyll"],
          answer: 0,
          explanation: "Oxygen is released into the air as a by-product.",
          quotes: [quote.oxygen],
        },
      ],
    },
  ],
};

/**
 * What an AI app would write for the review guide, through the API as a tool:
 * new objectives, so the course is the tool's alone, every quote in the handout.
 */
export const TOOL_WORK = {
  course: "Photosynthesis: a quick check",
  objectives: [
    {
      key: "photosynthesis-inputs",
      title: "Say what a plant takes in to make food",
      quotes: [quote.inputs],
      tasks: [
        {
          kind: "choice",
          prompt: "Where does a plant take in water?",
          options: ["Through its roots", "Through its leaves", "Through its flowers"],
          answer: 0,
          explanation: "Roots take up water from the soil; leaves take in carbon dioxide.",
          quotes: [quote.inputs],
        },
      ],
    },
    {
      key: "photosynthesis-outputs",
      title: "Say what a plant gives out",
      quotes: [quote.oxygen],
      tasks: [
        {
          kind: "typed",
          prompt: "Which gas does a plant release into the air?",
          accepted: ["oxygen"],
          answerLanguage: "en",
          explanation: "Oxygen is released into the air as a by-product.",
          quotes: [quote.oxygen],
        },
      ],
    },
  ],
};
