import { APPROVAL_REASON_MAX } from "@keel/shared";
import { type AuditActor, type Principal, requireRoleOn } from "./access";
import { ApiError } from "./errors";
import type { DeployRecord, Store } from "./store";

/** The role a member needs on the scope to approve or reject someone else's deploy. */
export const APPROVER_ROLE = "maintainer";

export type ApprovalDecision = "approved" | "rejected";

/**
 * Approves or rejects a deploy waiting for approval, as `p`. The approver needs `maintainer` on the deploy's scope
 * and can't be who asked for it. A rejection ends the deploy as `deploy_failed` with the reason; an approval lets
 * the worker start it as soon as its CI has passed. Records it in the audit log (`via` is `api` or `admin`).
 */
export async function decideDeploy(
  store: Store,
  p: Principal,
  actor: AuditActor,
  deploy: DeployRecord,
  decision: ApprovalDecision,
  input: { reason?: string | undefined; via: "api" | "admin" },
  now: Date,
): Promise<DeployRecord> {
  const target = { repo: deploy.repo, scope: deploy.scope };
  const verb = decision === "approved" ? "aprobar" : "rechazar";
  requireRoleOn(p, APPROVER_ROLE, `${verb} deploys`, target);
  if (!p.member) throw new ApiError(401, `Inicia sesión con tu token para ${verb} deploys.`);
  if (deploy.approval?.status !== "pending") {
    throw new ApiError(
      409,
      deploy.approval
        ? `El deploy ${deploy.id.slice(0, 8)} ya está ${deploy.approval.status === "approved" ? "aprobado" : "rechazado"}.`
        : `El deploy ${deploy.id.slice(0, 8)} no necesita aprobación.`,
    );
  }
  if (deploy.requestedByMemberId && deploy.requestedByMemberId === p.member.id) {
    throw new ApiError(403, `No puedes ${verb} tu propio deploy: tiene que hacerlo otro miembro.`);
  }
  const reason = input.reason?.trim() || null;
  if (reason && reason.length > APPROVAL_REASON_MAX) {
    throw new ApiError(400, `El motivo puede tener hasta ${APPROVAL_REASON_MAX} caracteres.`);
  }
  if (decision === "rejected" && !reason) throw new ApiError(400, "Escribe el motivo del rechazo.");

  return store.transaction(async (tx) => {
    const decided = await tx.decideApproval(
      deploy.id,
      { status: decision, by: actor.name, byMemberId: p.member?.id ?? null, reason },
      now,
    );
    if (!decided) throw new ApiError(409, `El deploy ${deploy.id.slice(0, 8)} ya no espera aprobación.`);
    if (decision === "rejected") {
      await tx.transition(deploy.id, "deploy_failed", now, { error: `Rechazado por ${actor.name}: ${reason}` });
    }
    await tx.recordAudit(
      {
        actor: actor.name,
        actorMemberId: actor.memberId,
        action: decision === "approved" ? "deploy.approve" : "deploy.reject",
        repo: deploy.repo,
        scope: deploy.scope,
        details: { deployId: deploy.id, tag: deploy.tag, ...(reason && { reason }), via: input.via },
      },
      now,
    );
    return (await tx.getDeploy(deploy.id)) as DeployRecord;
  });
}
