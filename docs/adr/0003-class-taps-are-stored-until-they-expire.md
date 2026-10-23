# Class Temporary Access Passes are stored until they expire

Imports can issue each new hire a Temporary Access Pass that starts when their onboarding class does, often days later. The IT person running the class then messages each person their pass. Microsoft Graph returns a pass's value only once, in the response that creates it, so OpenADUC has to keep the value until class. We store it encrypted with the app's secret key, purge it when the pass expires, and audit every reveal.

This goes against our rule of never storing a credential we hand out (one-off passes and generated passwords are shown once). It's acceptable here because Entra won't accept a pass before its start time, so a stored pass is inert until class and short-lived after it.

## Considered options

- **Create the passes in class.** The IT person would issue them one by one from each user's page. This avoids storage but turns the start of every class into a queue of admin clicks, and the Graph calls fail for anyone whose sync went wrong, at the worst moment.
- **Hand the passes out at import.** Printing or exporting the passes when the import runs puts live credentials on paper or in files for days, outside any audit trail.

## Consequences

A compromise of the database and the app's secret key exposes the passes for classes in progress, and for upcoming classes once they start. Revealing a pass needs step-up and the TAP capability, and the stored value is deleted when the pass expires or is replaced.
