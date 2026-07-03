export interface EpubMetadata {
  title: string
  author: string | null
  language: string | null
  coverHref: string | null
}

export interface EpubTocEntry {
  title: string
  href: string
}

export interface EpubManifestItem {
  id: string
  href: string
  mediaType: string
  properties: string | null
}
