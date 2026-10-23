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

**Naming pattern**:
The directory's rule for turning a person's name into a username, such as `{first}.{last}`.
_Avoid_: username format, naming convention

**Bucket**:
The rows of an import that share a value in the column the operator grouped by, such as one department. A bucket is created with one target OU and one set of groups.
_Avoid_: batch, group (a group is a directory object)

**Placement rule**:
A remembered mapping from a grouping column and value to a target OU and groups, prefilled when a later import has a bucket with that value.
_Avoid_: template, mapping

**Temporary Access Pass**:
A time-limited Entra passcode that lets a new hire sign in and register their own sign-in methods without a password. Abbreviated TAP.
_Avoid_: temp password, one-time code

**Class roster**:
The list of people from one import who attend an onboarding class, with each person's contact details and Temporary Access Pass.
_Avoid_: cohort, class list
