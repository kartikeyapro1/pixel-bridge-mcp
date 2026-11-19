/**
 * Prompt templates for reference-sheet generation. They aim for images that are
 * useful as Blender reference planes: full body, neutral pose, flat lighting,
 * plain background, consistent framing.
 */

export const TURNAROUND_VIEWS = ['front', 'side', 'back', 'three_quarter'] as const;
export type TurnaroundView = (typeof TURNAROUND_VIEWS)[number];

const VIEW_TEXT: Record<TurnaroundView, string> = {
  front: 'front view, facing the camera directly',
  side: 'exact side profile view, facing left, camera perpendicular to the character',
  back: 'back view, facing directly away from the camera',
  three_quarter: 'three-quarter view, turned 45 degrees to the left',
};

export function turnaroundPrompt(view: TurnaroundView, description: string, style?: string): string {
  const consistency =
    view === 'front'
      ? ''
      : ' Same character as the reference image: identical proportions, colours, markings, outfit and scale. Only the viewing angle changes.';
  return [
    `Character reference sheet image of ${description.trim()}.`,
    style ? `Style: ${style.trim()}.` : '',
    `${VIEW_TEXT[view]}.`,
    'Full body visible head to toe, centred, standing in a neutral A-pose with arms slightly away from the body.',
    'Orthographic-like camera with no perspective distortion, even flat studio lighting, no cast shadows,',
    'plain uniform light grey background, no text, no labels, no props, single character only.',
    consistency,
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}
