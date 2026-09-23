/**
 * Workflow Studio controller — thin HTTP wrappers over workflowStudioService.
 * Every handler is org/developer-scoped (session ownership enforced in the service).
 */
import { ok, handleError } from '../utils/respond.js';
import {
  composeWorkflow,
  dryRunWorkflow,
  chaosProbe,
  executeWorkflow,
  proveWorkflow
} from '../services/workflowStudioService.js';

const studioCtx = (req) => ({
  developerId: req.developerId,
  organizationId: req.organization?.id
});

export const studioCompose = async (req, res) => {
  try {
    const { consumerAgentId, serviceId, quantity } = req.body;
    const result = await composeWorkflow({ ...studioCtx(req), consumerAgentId, serviceId, quantity });
    return ok(res, { message: `🧩 Workflow composed for session ${result.workflow.sessionId} — review the steps, then dry run.`, ...result }, 201);
  } catch (err) {
    return handleError(res, err, 'studio-compose');
  }
};

export const studioDryRun = async (req, res) => {
  try {
    const result = await dryRunWorkflow({ ...studioCtx(req), sessionId: req.params.sessionId });
    return ok(res, {
      message: result.allClear
        ? `✅ Dry run passed — all ${result.steps.length} steps simulate clean. Nothing touched the chain.`
        : '⚠️ Dry run caught a reverting step. Nothing was broadcast.',
      ...result
    });
  } catch (err) {
    return handleError(res, err, 'studio-dry-run');
  }
};

export const studioChaos = async (req, res) => {
  try {
    const result = await chaosProbe({ ...studioCtx(req), sessionId: req.params.sessionId });
    return ok(res, {
      message: result.keeperHubRefused
        ? '🛡️ KeeperHub refused the tampered workflow in simulation — nothing was inferred, nothing was sent.'
        : '⚠️ The tampered workflow simulated clean — investigate before executing.',
      ...result
    });
  } catch (err) {
    return handleError(res, err, 'studio-chaos');
  }
};

export const studioExecute = async (req, res) => {
  try {
    const result = await executeWorkflow({ sessionId: req.params.sessionId, organizationId: req.organization?.id });
    if (result.success) {
      const exec = result.execution || {};
      const settle = exec.settleTxHash || result.createTxHash;
      const release = exec.releaseTxHash || result.releaseTxHash;
      return ok(res, {
        message: `⚡ Executed through KeeperHub — settle ${settle ? settle.slice(0, 10) + '…' : '(pending)'}, release ${release ? release.slice(0, 10) + '…' : '(pending)'}.`,
        ...result
      });
    }
    return ok(res, { message: `⚠️ Execution failed: ${result.failureReason}`, ...result }, 402);
  } catch (err) {
    return handleError(res, err, 'studio-execute');
  }
};

export const studioProve = async (req, res) => {
  try {
    const result = await proveWorkflow({ ...studioCtx(req), sessionId: req.params.sessionId });
    return ok(res, { message: result.verified ? `🔐 ${result.anchors.length} public HCS anchor(s) found for this session.` : 'No public anchors yet for this session.', ...result });
  } catch (err) {
    return handleError(res, err, 'studio-prove');
  }
};
