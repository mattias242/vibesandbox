## files — filer och bilagor

Användarna kan ladda upp filer till appen och visa eller ladda ned dem igen. Filerna hör till
appen: andra appar kommer inte åt dem, och förhandsvisningen har egna filer (tomt från början).
Spara `id` (t.ex. i ett dokument i `db`) för att koppla en fil till något.

```ts
import { files, SdkError } from '@vibesandbox/sdk';
// Typen heter files.FileInfo

files.upload(file: Blob | File | Uint8Array, options?: { name?: string; personal?: boolean; contentType?: string }): Promise<FileInfo>
files.list(): Promise<FileInfo[]>      // gemensamma + mina personliga, nyaste först (högst 1000)
files.get(id: string): Promise<FileInfo>
files.url(id: string): string          // relativ adress: <img src>, <audio src>, <a href download>
files.download(id: string): Promise<Blob>
files.remove(id: string): Promise<void>

interface FileInfo {
  id: string; name: string; contentType: string; size: number;   // size i byte
  createdAt: string; uploadedBy: string; personal: boolean;      // uploadedBy = whoami().userId
}
```

**Exempel — ladda upp bilder och visa dem:**

```tsx
import { useEffect, useState } from 'react';
import { files, SdkError } from '@vibesandbox/sdk';

export function Bilder() {
  const [bilder, setBilder] = useState<{ id: string; name: string }[]>([]);
  const [fel, setFel] = useState('');

  useEffect(() => {
    files.list().then((alla) => setBilder(alla.filter((f) => f.contentType.startsWith('image/'))));
  }, []);

  async function valj(e: React.ChangeEvent<HTMLInputElement>) {
    const fil = e.target.files?.[0];
    if (!fil) return;
    setFel('');
    try {
      const sparad = await files.upload(fil);   // namn och typ tas från filen
      setBilder((b) => [sparad, ...b]);
    } catch (err) {
      setFel(err instanceof SdkError ? err.message : 'Något gick fel.');
    } finally {
      e.target.value = '';
    }
  }

  return (
    <div>
      <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={valj} />
      {fel && <p role="alert">{fel}</p>}
      {bilder.map((b) => <img key={b.id} src={files.url(b.id)} alt={b.name} />)}
    </div>
  );
}
```

Andra filer länkas för nedladdning: `<a href={files.url(f.id)} download>{f.name}</a>`.

**Regler (plattformen kontrollerar dem):**

- **Tillåtna typer:** bilder (PNG, JPEG, WebP, GIF), PDF, text (`.txt`) och CSV, Word och Excel
  (`.docx`, `.xlsx`, utan makron) och ljud (MP3, M4A, WAV, Ogg, WebM). **SVG och HTML går inte.**
  Typen avgörs av filens innehåll; påstår filen något annat nekas den (`invalid_request`).
  Sätt `accept` på `<input type="file">` så att användaren bara kan välja sådant som går.
- **Storlek:** högst 20 MB per fil ⇒ annars `too_large`. Appen har ett begränsat utrymme för
  filer ⇒ `quota_exceeded` när det är fullt. Visa `err.message` — det är klarspråk.
- **Personliga filer:** `upload(fil, { personal: true })` — bara den som laddade upp filen ser
  den; för alla andra finns den inte (`not_found`).
- **Ta bort:** den som laddade upp filen, och appens ägare. Andra får `forbidden`.
- **Namnet** saneras av plattformen (inga sökvägar, rätt ändelse). Visa `name` som det är.
- Bilder visas direkt via `files.url`; andra filer laddas ned som bilaga.
