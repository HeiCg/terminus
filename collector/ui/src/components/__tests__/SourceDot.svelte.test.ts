import { render } from '@testing-library/svelte';
import { describe, it, expect } from 'vitest';
import SourceDot from '../SourceDot.svelte';

describe('SourceDot', () => {
  it.each<['xhr' | 'atlantis' | 'proxy']>([['xhr'], ['atlantis'], ['proxy']])(
    'colours the dot from the %s token',
    (source) => {
      const { container } = render(SourceDot, { props: { source } });
      expect(container.querySelector('.dot')!.getAttribute('style')).toContain(
        `var(--source-${source})`,
      );
    },
  );

  it('renders no label by default', () => {
    const { container } = render(SourceDot, { props: { source: 'proxy' } });
    expect(container.querySelector('.lbl')).toBeNull();
  });

  it('renders the label when label=true', () => {
    const { container } = render(SourceDot, { props: { source: 'proxy', label: true } });
    expect(container.querySelector('.lbl')).toHaveTextContent('proxy');
  });
});
