import { rename, writeFile } from 'node:fs/promises'

/** Keep the existing descriptor readable while Windows readers release their handles. */
export async function writeRuntimeDescriptor(file, contents, replace = rename) {
  const pending = `${file}.pending`
  await writeFile(pending, contents, { mode: 0o600 })
  for (let attempt = 0; ; attempt++) {
    try { await replace(pending, file); return }
    catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt === 7) throw error
      await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)))
    }
  }
}
