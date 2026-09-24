// Music theory helpers: keys, scales, chords. Everything snaps to a scale so it always sounds good.
export const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

export const SCALES = {
  'Major Pentatonic': [0, 2, 4, 7, 9],
  'Minor Pentatonic': [0, 3, 5, 7, 10],
  'Dorian': [0, 2, 3, 5, 7, 9, 10],
  'Major': [0, 2, 4, 5, 7, 9, 11],
  'Natural Minor': [0, 2, 3, 5, 7, 8, 10],
  'Japanese In': [0, 1, 5, 7, 8],
  'Lydian': [0, 2, 4, 6, 7, 9, 11],
};

// Heptatonic parents used to build diatonic chords for pentatonic scales.
const CHORD_PARENT = {
  'Major Pentatonic': 'Major',
  'Minor Pentatonic': 'Natural Minor',
  'Japanese In': 'Natural Minor',
};

export const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);
export const midiName = (m) => NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
export const pcName = (m) => NOTE_NAMES[((m % 12) + 12) % 12];

/** All MIDI notes of the scale between lo and hi (inclusive). */
export function scaleNotes(root, scaleName, lo, hi) {
  const steps = SCALES[scaleName];
  const out = [];
  for (let m = lo; m <= hi; m++) {
    const pc = (((m - root) % 12) + 12) % 12;
    if (steps.includes(pc)) out.push(m);
  }
  return out;
}

/** Diatonic triad (plus optional 7th) on a scale degree (0-based). */
export function chord(root, scaleName, degree, base = 48, seventh = false) {
  const parent = SCALES[CHORD_PARENT[scaleName] || scaleName];
  const steps = parent.length === 7 ? parent : SCALES.Major;
  const n = steps.length;
  const note = (d) => {
    const oct = Math.floor(d / n);
    return base + root + steps[((d % n) + n) % n] + 12 * oct;
  };
  const tones = [note(degree), note(degree + 2), note(degree + 4)];
  if (seventh) tones.push(note(degree + 6));
  return tones;
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
export function chordLabel(root, scaleName, degree) {
  const tones = chord(root, scaleName, degree, 48);
  const third = (tones[1] - tones[0] + 12) % 12;
  const fifth = (tones[2] - tones[0] + 12) % 12;
  let r = ROMAN[degree % 7];
  let suffix = '';
  if (third === 3) r = r.toLowerCase();
  if (fifth === 6) suffix = '°';
  return { roman: r + suffix, name: pcName(tones[0]) + (third === 3 ? (fifth === 6 ? 'dim' : 'm') : '') };
}
