"use client";

import { ROLES, type Role } from "@keel/shared";
import { useActionState } from "react";
import { IconPlus, IconRefresh, IconTrash } from "../icons";
import { ConfirmButton, TokenNotice } from "../ui-client";
import {
  addGrantAction,
  changeRoleAction,
  inviteMemberAction,
  type MemberFormState,
  removeGrantAction,
  resendInviteAction,
  setEnabledAction,
} from "./actions";

function FormError({ error }: { error: string | undefined }) {
  return error ? (
    <p className="error" role="alert">
      {error}
    </p>
  ) : null;
}

function RoleSelect({ id, defaultValue }: { id: string; defaultValue: Role }) {
  return (
    <select id={id} className="input" name="role" defaultValue={defaultValue}>
      {ROLES.map((role) => (
        <option key={role} value={role}>
          {role}
        </option>
      ))}
    </select>
  );
}

function InviteLink({ url, name }: { url: string; name?: string | undefined }) {
  return (
    <TokenNotice
      token={url}
      title="Copia este enlace ahora: no se vuelve a mostrar."
      hint={
        <>
          Mándaselo {name ? <strong>a {name}</strong> : "a la persona"} por un canal privado. Con él pone su contraseña;
          sirve una vez y vence en 7 días.
        </>
      }
    />
  );
}

export function InviteMemberForm() {
  const [state, action, pending] = useActionState<MemberFormState, FormData>(inviteMemberAction, {});
  return (
    <>
      <form action={action} className="form-row">
        <div className="field">
          <label className="label" htmlFor="member-name">
            Nombre
          </label>
          <input id="member-name" className="input" name="name" required maxLength={100} placeholder="Ana López" />
        </div>
        <div className="field">
          <label className="label" htmlFor="member-email">
            Email
          </label>
          <input
            id="member-email"
            className="input"
            name="email"
            type="email"
            required
            placeholder="ana@empresa.com"
            autoComplete="off"
          />
        </div>
        <div className="field narrow">
          <label className="label" htmlFor="member-role">
            Rol
          </label>
          <RoleSelect id="member-role" defaultValue="deployer" />
        </div>
        <button type="submit" className="btn" disabled={pending}>
          <IconPlus />
          {pending ? "Invitando…" : "Invitar"}
        </button>
      </form>
      <FormError error={state.error} />
      {state.inviteUrl && <InviteLink url={state.inviteUrl} name={state.name} />}
    </>
  );
}

export function ChangeRoleForm({ memberId, role }: { memberId: string; role: Role }) {
  const [state, action, pending] = useActionState<MemberFormState, FormData>(changeRoleAction.bind(null, memberId), {});
  return (
    <>
      <form action={action} className="form-row">
        <div className="field narrow">
          <label className="label" htmlFor="change-role">
            Rol base
          </label>
          <RoleSelect id="change-role" defaultValue={role} />
        </div>
        <button type="submit" className="btn btn-outline" disabled={pending}>
          {pending ? "Guardando…" : "Cambiar rol"}
        </button>
      </form>
      <FormError error={state.error} />
    </>
  );
}

export function ResendInviteForm({ memberId, label }: { memberId: string; label: string }) {
  const [state, action, pending] = useActionState<MemberFormState, FormData>(
    resendInviteAction.bind(null, memberId),
    {},
  );
  return (
    <>
      <form action={action}>
        <ConfirmButton
          variant="outline"
          size="md"
          disabled={pending}
          title="¿Generar un enlace nuevo?"
          message="Los enlaces anteriores dejarán de funcionar."
          confirmLabel="Generar enlace"
        >
          <IconRefresh />
          {pending ? "Generando…" : label}
        </ConfirmButton>
      </form>
      <FormError error={state.error} />
      {state.inviteUrl && <InviteLink url={state.inviteUrl} />}
    </>
  );
}

export function SetEnabledForm({ memberId, enabled, name }: { memberId: string; enabled: boolean; name: string }) {
  const [state, action, pending] = useActionState<MemberFormState, FormData>(
    setEnabledAction.bind(null, memberId, enabled),
    {},
  );
  return (
    <>
      <form action={action}>
        {enabled ? (
          <button type="submit" className="btn btn-outline" disabled={pending}>
            Habilitar
          </button>
        ) : (
          <ConfirmButton
            size="md"
            disabled={pending}
            title={`¿Deshabilitar a ${name}?`}
            message="Se cierra su sesión y sus tokens dejan de funcionar."
          >
            Deshabilitar
          </ConfirmButton>
        )}
      </form>
      <FormError error={state.error} />
    </>
  );
}

export function AddGrantForm({ memberId }: { memberId: string }) {
  const [state, action, pending] = useActionState<MemberFormState, FormData>(addGrantAction.bind(null, memberId), {});
  return (
    <>
      <form action={action} className="form-row">
        <div className="field">
          <label className="label" htmlFor="grant-repo">
            Patrón de repo
          </label>
          <input id="grant-repo" className="input" name="repo" placeholder="konectus-io/* (vacío = *)" />
        </div>
        <div className="field narrow">
          <label className="label" htmlFor="grant-scope">
            Patrón de scope
          </label>
          <input id="grant-scope" className="input" name="scope" placeholder="prod* (vacío = *)" />
        </div>
        <div className="field narrow">
          <label className="label" htmlFor="grant-role">
            Rol
          </label>
          <RoleSelect id="grant-role" defaultValue="viewer" />
        </div>
        <button type="submit" className="btn" disabled={pending}>
          <IconPlus />
          {pending ? "Agregando…" : "Agregar permiso"}
        </button>
      </form>
      <FormError error={state.error} />
    </>
  );
}

export function RemoveGrantButton({ grantId }: { grantId: string }) {
  const [state, action, pending] = useActionState<MemberFormState, FormData>(removeGrantAction.bind(null, grantId), {});
  return (
    <form action={action}>
      <button type="submit" className="btn btn-outline btn-sm" disabled={pending}>
        <IconTrash />
        Quitar
      </button>
      <FormError error={state.error} />
    </form>
  );
}
