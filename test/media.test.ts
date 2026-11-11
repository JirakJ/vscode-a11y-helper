import { describe, expect, it } from 'vitest';
import { auditMediaSource as audit, MediaRules } from '../src/core/media';

const rules = (src: string): string[] => audit(src, 't.html').issues.map((i) => i.rule.id);
const LIMIT = 8_000;

describe('MediaAccessibilityAuditor', () => {
  it('captioned video with controls passes', () => {
    const r = audit('<video controls src="a.mp4"><track kind="captions" src="a.vtt" srclang="en" label="English"></video>', 't.html');
    expect(r.issues).toEqual([]);
    expect(r.checked).toBe(1);
    expect(r.passed).toBe(1);
  });

  it('video without captions is an error and muted video only informational', () => {
    const err = audit('<video controls src="a.mp4"></video>', 't.html').issues;
    expect(err).toHaveLength(1);
    expect(err[0]!.rule.id).toBe(MediaRules.VIDEO_NO_CAPTIONS.id);
    expect(err[0]!.severity).toBe('ERROR');
    const muted = audit('<video controls muted loop src="bg.mp4"></video>', 't.html');
    expect(muted.issues).toHaveLength(1);
    expect(muted.issues[0]!.rule.id).toBe(MediaRules.VIDEO_NO_CAPTIONS.id);
    expect(muted.issues[0]!.severity).toBe('INFO');
    expect(muted.passed).toBe(1);
  });

  it('subtitles track counts as captions and dynamic children are skipped', () => {
    expect(rules('<video controls><track kind="subtitles" src="cs.vtt" srclang="cs"></video>')).toEqual([]);
    expect(rules('<video controls>{tracks.map(t => <track key={t.id} {...t} />)}</video>')).toEqual([]);
    expect(rules('<video controls><track kind={kind} src={src} srclang="en" /></video>')).toEqual([]);
    expect(rules('<video controls><CaptionTracks video={v} /></video>')).toEqual([]);
    expect(rules('<video controls><track kind="captions" srclang="en"></video>')).toEqual([MediaRules.VIDEO_NO_CAPTIONS.id]);
  });

  it('autoplay with sound is an error without controls and a warning with them', () => {
    const noControls = audit('<audio autoplay src="jingle.mp3"></audio>', 't.html').issues;
    expect(new Set(noControls.map((i) => i.rule.id))).toEqual(new Set([MediaRules.AUTOPLAY_WITH_SOUND.id, MediaRules.NO_CONTROLS.id]));
    expect(noControls.find((i) => i.rule.id === MediaRules.AUTOPLAY_WITH_SOUND.id)!.severity).toBe('ERROR');
    const withControls = audit('<audio autoplay controls src="jingle.mp3"></audio>', 't.html').issues;
    expect(withControls.map((i) => i.rule.id)).toEqual([MediaRules.AUTOPLAY_WITH_SOUND.id]);
    expect(withControls[0]!.severity).toBe('WARNING');
    expect(rules('<audio autoplay muted controls src="jingle.mp3"></audio>')).toEqual([]);
  });

  it('framework booleans are three-valued', () => {
    expect(rules('<audio autoPlay={false} controls src="a.mp3" />')).toEqual([]);
    expect(rules('<audio autoPlay muted={false} controls src="a.mp3" />')).toEqual([MediaRules.AUTOPLAY_WITH_SOUND.id]);
    expect(rules('<audio autoPlay muted={isMuted} controls src="a.mp3" />')).toEqual([]);
    expect(rules('<video controls muted={isMuted} src="a.mp4"></video>')).toEqual([]);
    expect(audit('<video hidden={false} controls src="a.mp4"></video>', 't.jsx').checked).toBe(1);
  });

  it('missing controls is informational and does not fail the element', () => {
    const r = audit('<audio src="a.mp3"></audio>', 't.html');
    expect(r.issues.map((i) => i.rule.id)).toEqual([MediaRules.NO_CONTROLS.id]);
    expect(r.issues[0]!.severity).toBe('INFO');
    expect(r.passed).toBe(1);
  });

  it('iframe needs a title', () => {
    const issues = audit('<div>\n<iframe src="https://maps.example"></iframe>', 't.html').issues;
    expect(issues).toHaveLength(1);
    expect(issues[0]!.rule.id).toBe(MediaRules.IFRAME_NO_TITLE.id);
    expect(issues[0]!.severity).toBe('ERROR');
    expect(issues[0]!.line).toBe(2);
    expect(rules('<iframe src="x" title="Office location map"></iframe>')).toEqual([]);
    expect(rules('<iframe src="x" aria-label="Map"></iframe>')).toEqual([]);
    expect(rules('<iframe src="x" title={title}></iframe>')).toEqual([]);
    expect(rules('<iframe src="x" :title="title"></iframe>')).toEqual([]);
    expect(rules('<iframe src="x" aria-hidden="true"></iframe>')).toEqual([]);
  });

  it('object and embed need a text alternative', () => {
    expect(rules('<object data="chart.svg" type="image/svg+xml"></object>')).toEqual([MediaRules.EMBED_NO_ALTERNATIVE.id]);
    expect(rules('<object data="chart.svg"><p>Sales grew 12 % in Q3.</p></object>')).toEqual([]);
    expect(rules('<embed src="anim.swf">')).toEqual([MediaRules.EMBED_NO_ALTERNATIVE.id]);
    expect(rules('<embed src="anim.swf" aria-label="Intro animation">')).toEqual([]);
  });

  it('caption track without srclang is informational', () => {
    const issues = audit('<video controls><track kind="captions" src="a.vtt"></video>', 't.html').issues;
    expect(issues.map((i) => i.rule.id)).toEqual([MediaRules.TRACK_NO_SRCLANG.id]);
    expect(issues[0]!.severity).toBe('INFO');
    expect(rules('<video controls><track kind="chapters" src="c.vtt"></video>')).not.toContain(MediaRules.TRACK_NO_SRCLANG.id);
  });

  it('components and hidden media are ignored', () => {
    const r = audit('<Video src="x" /><video hidden src="y"></video>', 't.html');
    expect(r.checked).toBe(0);
    expect(r.issues).toEqual([]);
  });

  it('unclosed video does not borrow tracks from a later one and Razor attributes are unknown', () => {
    const src = '<video controls src="a.mp4"><video controls src="b.mp4"><track kind="captions" src="b.vtt" srclang="en"></video>';
    const issues = audit(src, 't.html').issues.filter((i) => i.rule.id === MediaRules.VIDEO_NO_CAPTIONS.id);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.column).toBe(0);
    expect(rules('<iframe src="x" @attributes="FrameAttributes"></iframe>')).toEqual([]);
  });

  it('nested objects are summarised in linear time', { timeout: 60_000 }, () => {
    const src = '<object>'.repeat(4_000) + 'fallback' + '</object>'.repeat(4_000);
    const t = performance.now();
    const r = audit(src, 'nested.html');
    expect(r.issues).toEqual([]);
    expect(r.checked).toBe(4_000);
    expect(performance.now() - t).toBeLessThan(LIMIT);
    expect(rules('<object data="x"><!-- no fallback --> </object>')).toEqual([MediaRules.EMBED_NO_ALTERNATIVE.id]);
  });

  it('nested videos are checked in linear time', { timeout: 60_000 }, () => {
    const src = '<video controls><div>'.repeat(8_000) + 'fallback' + '</div></video>'.repeat(8_000);
    const t = performance.now();
    expect(audit(src, 'nested.html').checked).toBe(8_000);
    expect(performance.now() - t).toBeLessThan(LIMIT);
  });
});
