# OpenADUC

A self-hosted web app for administering Active Directory: finding and changing users, groups, computers and OUs, with every change recorded in an audit trail.

## Language

**Operator**:
A person signed in to OpenADUC to administer the directory, using their own AD account.
_Avoid_: admin, user (a user is a directory object)

**Step-up**:
Re-entering the operator's AD password to gain write access for a limited time.
_Avoid_: edit mode, elevation prompt

**Elevated session**:
The period after a step-up during which the operator's writes are allowed. It ends after an idle timeout, an absolute lifetime, or when the operator ends it.
_Avoid_: edit mode

**Old School view**:
The alternative UI that recreates the ADUC MMC window: OU tree, contents list and Properties dialogs.
_Avoid_: classic view, MMC mode, old-school look
