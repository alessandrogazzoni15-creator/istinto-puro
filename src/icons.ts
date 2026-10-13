import x from '@phosphor-icons/core/assets/bold/x-bold.svg?raw';
import search from '@phosphor-icons/core/assets/bold/magnifying-glass-bold.svg?raw';
import eye from '@phosphor-icons/core/assets/bold/eye-bold.svg?raw';
import eyeSlash from '@phosphor-icons/core/assets/bold/eye-slash-bold.svg?raw';
import external from '@phosphor-icons/core/assets/bold/arrow-up-right-bold.svg?raw';
import retry from '@phosphor-icons/core/assets/bold/arrow-clockwise-bold.svg?raw';
import shield from '@phosphor-icons/core/assets/bold/shield-bold.svg?raw';
import link from '@phosphor-icons/core/assets/bold/link-bold.svg?raw';
import check from '@phosphor-icons/core/assets/bold/check-bold.svg?raw';

const raw = { x, search, eye, eyeSlash, external, retry, shield, link, check };

export type IconName = keyof typeof raw;

export function icon(name: IconName): string {
  return raw[name].replace('<svg ', '<svg class="icon" aria-hidden="true" focusable="false" ');
}
