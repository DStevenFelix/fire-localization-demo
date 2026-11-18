import { expect, type Page } from '@playwright/test';
import type { createEmergencyMock } from './emergencyMock';
import type { FireSceneSeverity } from '../src/types';

declare global { interface Window { emergencyTest: ReturnType<typeof createEmergencyMock> } }
export async function connectMock(page: Page, count = 1, severity: FireSceneSeverity = 2, flightOnly = false) {
  await page.evaluate(async ({ count, severity, flightOnly }) => {
    const apiPath = '/src/utils/emergency.ts', mockPath = '/e2e/emergencyMock.ts';
    const api = await import(apiPath), fixture = await import(mockPath);
    const service = api.getEmergencyService();
    window.emergencyTest = fixture.createEmergencyMock(service);
    service.connect(window.emergencyTest.adapter);
    if (flightOnly) window.emergencyTest.begin();
    if (!flightOnly) window.emergencyTest.prepare(count, severity);
  }, { count, severity, flightOnly });
  await expect(page.getByTestId('emergency-phase')).toHaveAttribute('data-phase', flightOnly ? 'drone_dispatched' : 'awaiting_confirmation');
}
export async function assess(page: Page, targetPoiId: string, severity: FireSceneSeverity = 2) {
  await page.evaluate(async ({ targetPoiId, severity }) => {
    const path = '/src/utils/emergency.ts';
    const api = await import(path), service = api.getEmergencyService(), now = Date.now();
    service.receive({ type: 'fire.detected', incidentId: 'SCENE-CHECK', messageId: `${now}:detected`, occurredAt: now, targetPoiId });
    const drone = service.getSnapshot().drones[0];
    service.receive({ type: 'drone.update', incidentId: 'SCENE-CHECK', messageId: `${now}:dispatch`, occurredAt: now,
      drone: { ...drone, path: undefined, status: 'flying', targetPoiId, updatedAt: now } });
    service.receive({ type: 'drone.observed', incidentId: 'SCENE-CHECK', messageId: `${now}:observed`, occurredAt: now, droneId: drone.id });
    service.receive({ type: 'fire.assessed', incidentId: 'SCENE-CHECK', messageId: `${now}:assessment:${severity}`, occurredAt: now,
      assessment: { targetPoiId, severity, status: 'completed', result: '外部侦察结果' } });
  }, { targetPoiId, severity });
}
