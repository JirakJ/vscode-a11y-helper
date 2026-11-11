/*
 * Copyright 2026 Jakub Jirák
 * SPDX-License-Identifier: Apache-2.0
 */

import { MarkupDocument, MarkupTag, parseMarkup } from './markup';
import { AuditRule, IssueSeverity, MarkupAuditReport, MarkupIssue, reportOf } from './markupAudit';

/** Rules reported by {@link auditMedia}. */
export const MediaRules = {
  VIDEO_NO_CAPTIONS: {
    id: 'media-video-no-captions', title: 'Video without captions track', wcag: 'WCAG 1.2.2',
    helpUri: 'https://www.w3.org/WAI/WCAG22/Understanding/captions-prerecorded.html',
  },
  AUTOPLAY_WITH_SOUND: {
    id: 'media-autoplay-sound', title: 'Media autoplays with sound', wcag: 'WCAG 1.4.2',
    helpUri: 'https://www.w3.org/WAI/WCAG22/Understanding/audio-control.html',
  },
  NO_CONTROLS: {
    id: 'media-no-controls', title: 'Media element without controls', wcag: 'WCAG 1.4.2 / 2.1.1',
    helpUri: 'https://www.w3.org/WAI/WCAG22/Understanding/audio-control.html',
  },
  IFRAME_NO_TITLE: {
    id: 'media-iframe-no-title', title: 'Frame without accessible name', wcag: 'WCAG 4.1.2 / 2.4.1',
    helpUri: 'https://www.w3.org/WAI/WCAG22/Techniques/html/H64',
  },
  EMBED_NO_ALTERNATIVE: {
    id: 'media-embed-no-alternative', title: 'Embedded object without text alternative', wcag: 'WCAG 1.1.1',
    helpUri: 'https://www.w3.org/WAI/WCAG22/Understanding/non-text-content.html',
  },
  TRACK_NO_SRCLANG: {
    id: 'media-track-no-srclang', title: 'Text track without srclang', wcag: 'WCAG 1.2.2 / 3.1.2',
    helpUri: 'https://developer.mozilla.org/docs/Web/HTML/Element/track',
  },
} as const satisfies Record<string, AuditRule>;

export const MEDIA_RULES: readonly AuditRule[] = Object.values(MediaRules);

const CAPTION_KINDS: ReadonlySet<string> = new Set(['captions', 'subtitles']);

type Reporter = (tag: MarkupTag, rule: AuditRule, severity: IssueSeverity, message: string, suggestion: string) => void;

/**
 * Audits time-based media and embedded content. Boolean attributes are
 * three-valued ({@link MarkupTag.boolAttr}): a runtime value such as
 * `muted={isMuted}` disables the rule instead of guessing.
 *
 * - `<video>` without a usable captions/subtitles `<track>` — ERROR (INFO when muted),
 * - `autoplay` without `muted` — ERROR without controls, WARNING with,
 * - `<audio>` / `<video>` without `controls` — INFO,
 * - `<iframe>` / `<frame>` without a name — ERROR,
 * - `<object>` / `<embed>` without a text alternative — WARNING,
 * - captions track without `srclang` — INFO.
 */
export function auditMedia(doc: MarkupDocument, filePath: string): MarkupAuditReport {
  const tags = doc.tags;
  const issues: MarkupIssue[] = [];
  let checked = 0;
  const failing = new Set<number>();
  let captionPositions: number[] | undefined;
  const captions = (): number[] => {
    if (!captionPositions) {
      captionPositions = [];
      tags.forEach((c, i) => {
        if (!c.isClose && c.lowerName === 'track' &&
          (c.hasSpread || c.isDynamic('kind') || CAPTION_KINDS.has(c.attr('kind')?.toLowerCase() ?? 'subtitles')) &&
          (c.hasSpread || c.has('src') || c.hasBinding('src'))) {
          captionPositions!.push(i);
        }
      });
    }
    return captionPositions;
  };

  const report: Reporter = (tag, rule, severity, message, suggestion) => {
    if (severity !== 'INFO') failing.add(tag.startOffset);
    issues.push({ rule, severity, line: tag.line, column: tag.column, message, suggestion });
  };

  tags.forEach((tag, index) => {
    if (tag.isClose || tag.isComponent || tag.hasSpread) return;
    if (doc.isHidden(index)) return;
    switch (tag.lowerName) {
      case 'video':
      case 'audio':
        checked++;
        auditMediaElement(doc, index, captions, report);
        break;
      case 'iframe':
      case 'frame':
        checked++;
        if (!hasName(tag)) {
          report(
            tag, MediaRules.IFRAME_NO_TITLE, 'ERROR',
            `<${tag.lowerName}> has no title — screen-reader users cannot tell what the frame contains.`,
            'Add a concise title="…" describing the embedded content (e.g. "Product demo video").',
          );
        }
        break;
      case 'object':
      case 'embed': {
        checked++;
        const isObject = tag.lowerName === 'object';
        const hasFallback = isObject && doc.hasAnyText(index);
        const dynamic = isObject && doc.hasDynamicContent(index);
        if (!hasName(tag) && !hasFallback && !dynamic) {
          report(
            tag, MediaRules.EMBED_NO_ALTERNATIVE, 'WARNING',
            `<${tag.lowerName}> provides no text alternative for its content.`,
            isObject
              ? 'Add fallback text inside <object>…</object> or an aria-label.'
              : 'Add aria-label="…" or title="…" describing the embedded content.',
          );
        }
        break;
      }
      case 'track': {
        if (tag.isDynamic('kind')) return;
        const kind = tag.attr('kind')?.toLowerCase() ?? 'subtitles';
        if (CAPTION_KINDS.has(kind) && !tag.has('srclang') && !tag.hasBinding('srclang')) {
          report(
            tag, MediaRules.TRACK_NO_SRCLANG, 'INFO',
            `<track kind="${kind}"> has no srclang — players cannot match the user's preferred language.`,
            'Add srclang="en" (BCP 47) and a human-readable label="English".',
          );
        }
        break;
      }
    }
  });

  issues.sort((a, b) => a.line - b.line || a.column - b.column);
  return reportOf(filePath, checked, failing.size, issues);
}

/** Convenience overload: parses `source` first. */
export function auditMediaSource(source: string, filePath: string): MarkupAuditReport {
  return auditMedia(parseMarkup(source), filePath);
}

function auditMediaElement(doc: MarkupDocument, index: number, captions: () => number[], report: Reporter): void {
  const tags = doc.tags;
  const tag = tags[index]!;
  const muted = tag.boolAttr('muted');
  const autoplay = tag.boolAttr('autoplay');
  const controls = tag.boolAttr('controls');

  if (autoplay === true && muted === false) {
    if (controls === false) {
      report(
        tag, MediaRules.AUTOPLAY_WITH_SOUND, 'ERROR',
        `<${tag.lowerName}> autoplays with sound and offers no controls to stop it — it competes with screen-reader speech (WCAG 1.4.2).`,
        'Remove autoplay, add muted, or add controls so the user can pause within 3 seconds.',
      );
    } else if (controls === true) {
      report(
        tag, MediaRules.AUTOPLAY_WITH_SOUND, 'WARNING',
        `<${tag.lowerName}> autoplays with sound; WCAG 1.4.2 allows this only if it stops within 3 s or the visible controls let the user pause it first.`,
        'Prefer muted autoplay, or make sure the controls are reachable before any other content.',
      );
    }
  }

  if (tag.lowerName === 'video' && muted !== null) {
    const end = Math.min(Math.max(doc.contentEndIndex[index]!, index + 1), tags.length);
    const hasCaptions = !tag.selfClosing && anyBetween(captions(), index, end);
    const dynamicChildren = !tag.selfClosing && doc.hasDynamicContent(index);
    if (!hasCaptions && !dynamicChildren) {
      report(
        tag, MediaRules.VIDEO_NO_CAPTIONS, muted ? 'INFO' : 'ERROR',
        muted
          ? '<video muted> has no captions track — fine for silent/decorative video, required if it conveys speech.'
          : '<video> has no <track kind="captions"> — deaf and hard-of-hearing users get no dialogue.',
        'Add <track kind="captions" src="….vtt" srclang="en" label="English"> inside the <video>.',
      );
    }
  }

  if (controls === false) {
    report(
      tag, MediaRules.NO_CONTROLS, 'INFO',
      `<${tag.lowerName}> has no controls attribute — make sure a custom, keyboard-operable player is provided.`,
      'Add the controls attribute, or verify the custom player exposes play/pause/volume to the keyboard.',
    );
  }
}

/** `true` when a sorted position lies strictly inside (from, to). */
function anyBetween(positions: number[], from: number, to: number): boolean {
  let lo = 0;
  let hi = positions.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (positions[mid]! <= from) lo = mid + 1; else hi = mid;
  }
  return lo < positions.length && positions[lo]! < to;
}

function hasName(tag: MarkupTag): boolean {
  return tag.attr('title') !== null || tag.attr('aria-label') !== null || tag.attr('aria-labelledby') !== null ||
    tag.hasBinding('title') || tag.hasBinding('aria-label') || tag.hasBinding('aria-labelledby');
}
