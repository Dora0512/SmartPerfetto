// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import type {AnalysisResult} from '../../agent/core/orchestratorTypes';
import {localize, type OutputLanguage} from '../../agentv3/outputLanguage';
import {projectSceneTimelineForClient} from '../../agent/scene/sceneTimelineProjection';
import type {SceneTimelineView} from '../../types/sceneTimeline';

const escape = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g,
  char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]!));

function detailsLink(input: {
  timeline: SceneTimelineView;
  reference?: AnalysisResult['sceneReport'];
  language: OutputLanguage;
  backendBaseUrl?: string;
}): string {
  const {reference, timeline, language} = input;
  if (!reference || reference.schemaVersion !== 'scene_report_ref@1' ||
    reference.traceId !== timeline.traceId || reference.sessionId !== timeline.sessionId ||
    reference.runId !== timeline.runId || reference.revision !== timeline.revision ||
    typeof reference.reportId !== 'string' || !reference.reportId.startsWith('scene-v3-') ||
    !/^[a-f0-9]{64}$/.test(reference.manifestSha256) || (!Number.isSafeInteger(reference.expiresAt) || reference.expiresAt <= Date.now())) {
    return `<p>${escape(localize(language, '场景归档详情不可用。', 'Scene archive details are unavailable.'))}</p>`;
  }
  const relative = `/api/agent/v1/scene-reconstruct/report/${encodeURIComponent(reference.reportId)}`;
  let href = relative;
  if (input.backendBaseUrl) {
    try {
      const base = new URL(input.backendBaseUrl);
      if (base.protocol === 'http:' || base.protocol === 'https:') href = new URL(relative, base.origin).href;
    } catch { /* Keep the existing authenticated relative endpoint. */ }
  }
  return `<p><a href="${escape(href)}" target="_blank" rel="noopener noreferrer">${escape(localize(language,
    '场景详情（JSON）', 'Scene details (JSON)'))}</a> — ${escape(localize(language,
    '历史归档；访问仍需权限，过期或删除后不可用。此链接不会重新验证场景。',
    'Historical archive; access requires authorization and may expire or be deleted. This link does not reverify the scene.'))}</p>`;
}

/** Render the canonical view directly; no detector, generic table preview limit, or raw audit row export. */
export function renderSceneTimelineHtml(input: {
  timeline?: SceneTimelineView;
  reference?: AnalysisResult['sceneReport'];
  outputLanguage: OutputLanguage;
  backendBaseUrl?: string;
}): string {
  if (!input.timeline) return '';
  // Also strip audit rows when a structurally compatible full assessment reaches this boundary.
  const timeline = projectSceneTimelineForClient(input.timeline);
  const language = input.outputLanguage;
  const label = (zh: string, en: string) => escape(localize(language, zh, en));
  const list = (items: readonly string[]) => items.length ? `<ul>${items.map(item => `<li>${escape(item)}</li>`).join('')}</ul>` : '';
  const sources = timeline.coverage.sources.map(source => `<li>${escape(source.domain)} / ${escape(source.source)}:
    ${escape(source.scanStatus)}; ${source.windows.map(window =>
      `<code>${escape(window.startNs)} → ${escape(window.endNs)} ns</code>`).join(', ')}
    ${list(source.issues)}</li>`).join('');
  const targets = timeline.coverage.targets?.map(target => `<li>${escape(target.id)}: ${escape(target.scanStatus)};
    ${label('观测', 'Observation')}: ${escape(target.observationStatus)};
    ${label('未查询区间', 'Unscanned windows')}: ${target.unscannedWindows.map(window =>
      `<code>${escape(window.startNs)} → ${escape(window.endNs)} ns</code>`).join(', ')}
    ${list(target.issues)}</li>`).join('');
  const segments = timeline.segments.map(value => {
    const {segment} = value;
    const checks = value.checks.map(check => `<li><code>${escape(check.predicate)}</code>: ${escape(check.status)}${check.reason
      ? ` — ${escape(check.reason)}` : ''}</li>`).join('');
    const references = segment.evidenceRefs.map(reference => `<li><code>${escape(reference.artifactId ?? reference.evidenceRefId ?? reference.sourceToolCallId)}</code>
      / ${label('原始行', 'original row')} ${escape(reference.rowIndex)}${reference.column
        ? ` / ${escape(reference.column)}` : ''}</li>`).join('');
    const diagnostics = value.diagnostics.map(diagnostic => `${diagnostic.code}${diagnostic.detail ? `: ${diagnostic.detail}` : ''}`);
    return `<article class="scene-timeline-segment" data-segment-id="${escape(segment.id)}" style="border:1px solid #e5e7eb;border-radius:8px;padding:12px;margin:12px 0">
      <h3>${escape(segment.id)}</h3>
      <p><code>${escape(segment.startNs)} → ${escape(segment.endNs)} ns</code></p>
      <p>${label('对象', 'Object')}: ${escape(segment.object.kind)} / ${escape(segment.object.key)}${segment.object.machineId
        ? ` / machine ${escape(segment.object.machineId)}` : ''}</p>
      <dl style="white-space:pre-wrap;overflow-wrap:anywhere">
        <dt><strong>${label('用户操作', 'User action')}</strong></dt><dd>${escape(segment.userAction)}</dd>
        <dt><strong>${label('设备状态', 'Device state')}</strong></dt><dd>${escape(segment.deviceState)}</dd>
        <dt><strong>${label('应用响应', 'Application response')}</strong></dt><dd>${escape(segment.appResponse)}</dd>
      </dl>
      <p>${label('叙述核验状态', 'Story verification status')}: ${escape(value.semanticStatus)}</p>
      <details><summary>${label('有限检查与证据定位', 'Finite checks and evidence locators')}</summary>
        <p>${label('检查通过仅代表对应谓词，不代表叙述、归属或覆盖已确认。',
          'A passed check establishes only its predicate, not the story, attribution or coverage.')}</p>
        <ul>${checks}</ul><ul>${references}</ul>${list(diagnostics)}
      </details>
    </article>`;
  }).join('');
  return `<section class="section scene-timeline" data-scene-run="${escape(timeline.runId)}" data-scene-revision="${escape(timeline.revision)}">
    <h2 class="section-title">${label('场景时间线', 'Scene timeline')}</h2>
    <p>${label('版本', 'Revision')}: ${escape(timeline.revision)}; ${label('状态', 'Status')}: ${escape(timeline.status)}</p>
    <p>${label('查询覆盖状态', 'Query coverage status')}: ${escape(timeline.coverage.status)};
      ${label('采集完整性', 'Capture completeness')}: ${escape(timeline.coverage.captureStatus)} — ${escape(timeline.coverage.reason)}</p>
    ${sources ? `<details><summary>${label('扫描来源与区间', 'Scan sources and windows')}</summary><ul>${sources}</ul></details>` : ''}
    ${targets ? `<details><summary>${label('必查目标与缺口', 'Required query targets and gaps')}</summary><ul>${targets}</ul></details>` : ''}
    ${detailsLink({timeline, reference: input.reference, language, backendBaseUrl: input.backendBaseUrl})}
    ${segments || `<p>${label('没有可交付的场景分段。', 'No scene segments are available.')}</p>`}
    ${timeline.unresolved.length ? `<h3>${label('未决问题', 'Unresolved questions')}</h3>${list(timeline.unresolved)}` : ''}
    ${list(timeline.diagnostics.map(diagnostic => `${diagnostic.code}${diagnostic.detail ? `: ${diagnostic.detail}` : ''}`))}
  </section>`;
}
