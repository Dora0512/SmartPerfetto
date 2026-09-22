// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';
import {
  addAtraceCategories,
  calculateCaptureBufferSizeKb,
  getCapturePreset,
  listCapturePresets,
  renderAndroidTraceConfig,
  renderTraceConfigTemplate,
} from '../traceCaptureConfig';

describe('shared trace capture config rendering', () => {
  it('renders the Camera preset with binder, FrameTimeline, and DMA-BUF evidence', () => {
    const preset = getCapturePreset('camera');
    const config = renderAndroidTraceConfig({
      target: 'android',
      preset: 'camera',
      app: 'com.example.camera',
      durationSeconds: 20,
    });

    expect(preset.intent).toBe('camera');
    expect(config).toContain('atrace_categories: "camera"');
    expect(config).toContain('atrace_categories: "hal"');
    expect(config).toContain('ftrace_events: "dmabuf_heap/dma_heap_stat"');
    expect(config).toContain('ftrace_events: "ion/ion_stat"');
    expect(config).toContain('ftrace_events: "binder/binder_transaction"');
    expect(config).toContain('name: "android.surfaceflinger.frametimeline"');
  });

  it('keeps Camera memory evidence in the full diagnostic preset', () => {
    const config = renderAndroidTraceConfig({
      target: 'android',
      preset: 'full',
      app: '*',
      durationSeconds: 20,
    });

    expect(config).toContain('ftrace_events: "dmabuf_heap/dma_heap_stat"');
    expect(config).toContain('ftrace_events: "ion/ion_stat"');
  });

  it('renders every built-in Android preset through the shared service', () => {
    for (const preset of listCapturePresets()) {
      const config = renderAndroidTraceConfig({
        target: 'android',
        preset: preset.id,
        app: 'com.example.app',
        durationSeconds: preset.defaultDurationSeconds,
      });

      expect(config).toContain(`SmartPerfetto capture preset: ${preset.id}`);
      expect(config).toContain('name: "linux.ftrace"');
      expect(config).toContain('ftrace_events: "sched/sched_blocked_reason"');
      // Actual frequency without its bounds cannot distinguish an idle CPU from
      // a clamped one, so every preset carries both.
      expect(config).toContain('ftrace_events: "power/cpu_frequency"');
      expect(config).toContain('ftrace_events: "power/cpu_frequency_limits"');
      expect(config).toContain('duration_ms:');
      expect(config).toContain('atrace_apps: "com.example.app"');
    }
  });

  it.each(['cpu', 'power', 'full'] as const)(
    'gives the %s preset thermal zone and cooling device events',
    (presetId) => {
      const config = renderAndroidTraceConfig({
        target: 'android',
        preset: presetId,
        app: 'com.example.app',
        durationSeconds: 15,
      });

      expect(config).toContain('ftrace_events: "thermal/thermal_temperature"');
      expect(config).toContain('ftrace_events: "thermal/cdev_update"');
      expect(config).toContain('ftrace_events: "power/cpu_frequency_limits"');
    },
  );

  it('keeps template rendering and duration-scaled buffers in the shared service', () => {
    const rendered = renderTraceConfigTemplate([
      'buffers { size_kb: {buffer_size_kb} fill_policy: RING_BUFFER }',
      'duration_ms: {duration_ms}',
    ].join('\n'), { durationSeconds: 90 });

    expect(rendered.templated).toBe(true);
    expect(rendered.textproto).toContain('duration_ms: 90000');
    expect(rendered.textproto).toContain(`size_kb: ${512 * 1024}`);
    expect(calculateCaptureBufferSizeKb(1)).toBe(64 * 1024);
    expect(calculateCaptureBufferSizeKb(90)).toBe(512 * 1024);
  });

  it('injects additional atrace categories without duplicating existing categories', () => {
    const generated = renderAndroidTraceConfig({
      target: 'android',
      preset: 'startup',
      app: 'com.example.app',
      durationSeconds: 5,
      extraAtraceCategories: ['dalvikviktime', 'my_custom_tag'],
    });
    expect(generated).toContain('atrace_categories: "dalvikviktime"');
    expect(generated).toContain('atrace_categories: "my_custom_tag"');

    const passThrough = addAtraceCategories([
      'data_sources {',
      '  config {',
      '    name: "linux.ftrace"',
      '    ftrace_config {',
      '      atrace_categories: "am"',
      '      atrace_apps: "*"',
      '    }',
      '  }',
      '}',
    ].join('\n'), ['am', 'custom']);
    expect(passThrough.match(/atrace_categories: "am"/g)).toHaveLength(1);
    expect(passThrough).toContain('atrace_categories: "custom"');
  });
});
