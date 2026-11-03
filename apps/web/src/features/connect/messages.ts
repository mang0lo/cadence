import type { Dictionary } from '@/lib/i18n';

export const messages: Dictionary = {
  en: {
    nav: { title: 'Watches' },
    page: {
      title: 'Other watches',
      subtitle:
        'Bring in activities from watches that don’t sync to Apple Health — straight from the vendor’s cloud.',
      fitTitle: 'Any other watch: FIT files',
      fitHint:
        'Garmin, Suunto, Wahoo, Polar and most bike computers export FIT files. Drop single .fit files or a zip of them on the import page.',
      toImport: 'Go to import',
    },
    coros: {
      title: 'COROS',
      subtitle: 'Activities from COROS Training Hub',
      unofficial:
        'Unofficial: Cadence uses the same private interface as the Training Hub website. COROS can change it at any time, and logging into Training Hub in a browser may sign Cadence out (it signs in again by itself).',
      email: 'COROS account email',
      password: 'Password',
      passwordHint:
        'Sent to COROS only. Cadence keeps the login token and a hash of the password to sign in again — never the password itself.',
      region: 'Account region',
      regions: { eu: 'Europe', en: 'Americas & rest of world', cn: 'China' },
      connect: 'Connect COROS',
      connected: 'Connected as {name}',
      since: 'Connected {when}',
      lastSync: 'Last sync',
      never: 'Never',
      fetched: 'Activities fetched',
      failed: 'Could not download',
      newest: 'Newest activity',
      healthDays: 'Health data',
      healthRange: { one: '1 day ({from} – {to})', other: '{count} days ({from} – {to})' },
      healthSynced: { one: 'Health data of 1 day updated.', other: 'Health data of {count} days updated.' },
      notMyWatch: 'Your watch in Settings is {watch}: Apple Health values win where both exist.',
      toSettings: 'Change in Settings',
      syncNow: 'Sync now',
      fullSync: 'Full sync',
      fullSyncHint:
        'Fetches every activity again, including ones that failed before. Use it after “Delete all data”.',
      mobileData: 'Sleep, steps & all-day heart rate',
      mobileDataHint:
        'Read through the COROS app’s interface. Its first login can sign the COROS app on your phone out once — just log in there again. Cadence keeps its token and only logs in again when COROS asks for it.',
      sleepSynced: { one: '1 night of sleep updated.', other: '{count} nights of sleep updated.' },
      autoSync: 'Sync automatically',
      autoSyncHint: 'When Cadence starts and every 3 hours while it runs.',
      disconnect: 'Disconnect',
      disconnectConfirm: 'Disconnect COROS? Imported activities stay in Cadence.',
      states: {
        listing: 'Reading the activity list…',
        downloading: 'Downloading activities {done} / {total}',
        health: 'Reading resting heart rate, HRV and training load…',
        done: 'Sync finished',
        failed: 'Sync failed',
      },
      result: {
        none: 'No new activities.',
        some: {
          one: '1 new activity is being imported.',
          other: '{count} new activities are being imported.',
        },
      },
      showImport: 'Show import',
    },
  },
  de: {
    nav: { title: 'Uhren' },
    page: {
      title: 'Andere Uhren',
      subtitle:
        'Aktivitäten von Uhren, die nicht mit Apple Health synchronisieren – direkt aus der Cloud des Herstellers.',
      fitTitle: 'Jede andere Uhr: FIT-Dateien',
      fitHint:
        'Garmin, Suunto, Wahoo, Polar und die meisten Radcomputer exportieren FIT-Dateien. Einzelne .fit-Dateien oder ein Zip davon auf der Import-Seite ablegen.',
      toImport: 'Zum Import',
    },
    coros: {
      title: 'COROS',
      subtitle: 'Aktivitäten aus dem COROS Training Hub',
      unofficial:
        'Inoffiziell: Cadence nutzt dieselbe private Schnittstelle wie die Training-Hub-Website. COROS kann sie jederzeit ändern, und eine Anmeldung im Training Hub im Browser kann Cadence abmelden (es meldet sich selbst wieder an).',
      email: 'E-Mail des COROS-Kontos',
      password: 'Passwort',
      passwordHint:
        'Wird nur an COROS gesendet. Cadence speichert das Anmelde-Token und einen Hash des Passworts zur erneuten Anmeldung – nie das Passwort selbst.',
      region: 'Region des Kontos',
      regions: { eu: 'Europa', en: 'Amerika & übrige Welt', cn: 'China' },
      connect: 'COROS verbinden',
      connected: 'Verbunden als {name}',
      since: 'Verbunden {when}',
      lastSync: 'Letzte Synchronisierung',
      never: 'Nie',
      fetched: 'Geladene Aktivitäten',
      failed: 'Nicht ladbar',
      newest: 'Neueste Aktivität',
      healthDays: 'Gesundheitsdaten',
      healthRange: { one: '1 Tag ({from} – {to})', other: '{count} Tage ({from} – {to})' },
      healthSynced: {
        one: 'Gesundheitsdaten von 1 Tag aktualisiert.',
        other: 'Gesundheitsdaten von {count} Tagen aktualisiert.',
      },
      notMyWatch:
        'Deine Uhr in den Einstellungen ist {watch}: Wo beides vorhanden ist, gelten die Werte aus Apple Health.',
      toSettings: 'In den Einstellungen ändern',
      syncNow: 'Jetzt synchronisieren',
      fullSync: 'Vollständig synchronisieren',
      fullSyncHint:
        'Lädt alle Aktivitäten erneut, auch zuvor fehlgeschlagene. Nach „Alle Daten löschen“ verwenden.',
      mobileData: 'Schlaf, Schritte & Tagesherzfrequenz',
      mobileDataHint:
        'Wird über die Schnittstelle der COROS-App gelesen. Die erste Anmeldung kann die COROS-App auf deinem Handy einmal abmelden – melde dich dort einfach wieder an. Cadence behält das Token und meldet sich nur neu an, wenn COROS es verlangt.',
      sleepSynced: { one: 'Schlaf von 1 Nacht aktualisiert.', other: 'Schlaf von {count} Nächten aktualisiert.' },
      autoSync: 'Automatisch synchronisieren',
      autoSyncHint: 'Beim Start von Cadence und alle 3 Stunden, solange es läuft.',
      disconnect: 'Trennen',
      disconnectConfirm: 'COROS trennen? Importierte Aktivitäten bleiben in Cadence.',
      states: {
        listing: 'Aktivitätsliste wird gelesen …',
        downloading: 'Aktivitäten werden geladen {done} / {total}',
        health: 'Ruhepuls, HRV und Trainingslast werden gelesen …',
        done: 'Synchronisierung abgeschlossen',
        failed: 'Synchronisierung fehlgeschlagen',
      },
      result: {
        none: 'Keine neuen Aktivitäten.',
        some: {
          one: '1 neue Aktivität wird importiert.',
          other: '{count} neue Aktivitäten werden importiert.',
        },
      },
      showImport: 'Import anzeigen',
    },
  },
};
