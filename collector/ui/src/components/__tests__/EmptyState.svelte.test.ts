import { render } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { describe, it, expect } from 'vitest';
import EmptyState from '../EmptyState.svelte';

const snippet = (text: string) =>
  createRawSnippet(() => ({ render: () => `<button>${text}</button>` }));

describe('EmptyState', () => {
  it('renders the title', () => {
    const { container } = render(EmptyState, { props: { title: 'Nothing here' } });
    expect(container.querySelector('.title')).toHaveTextContent('Nothing here');
  });

  it('renders the hint when given', () => {
    const { container } = render(EmptyState, {
      props: { title: 'Empty', hint: 'Try capturing traffic' },
    });
    expect(container.querySelector('.hint')).toHaveTextContent('Try capturing traffic');
  });

  it('omits the hint when not given', () => {
    const { container } = render(EmptyState, { props: { title: 'Empty' } });
    expect(container.querySelector('.hint')).toBeNull();
  });

  it('renders the action snippet when given', () => {
    const { container } = render(EmptyState, {
      props: { title: 'Empty', action: snippet('Retry') },
    });
    expect(container.querySelector('.action')).toHaveTextContent('Retry');
  });
});
