// Owner: cards/layout. The base layer's public components; campfire, room and end import them from here only.
export { Card, CARD_BOX, type CardProps } from './card';
export { Hand, type HandProps } from './hand';
export { Books, type BooksProps } from './books';
export { Piles, type PilesProps } from './piles';
export { Inspector, type InspectorProps } from './inspector';
/** The agent sigil (Claude star, Codex prompt), for head tags and lane labels that should match the cards. */
export { Sigil } from './dom';
