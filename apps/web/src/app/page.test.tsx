import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import HomePage from './page';

describe('HomePage', () => {
  it('renders the StoryMe heading', () => {
    render(<HomePage />);
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toBeDefined();
    expect(heading.textContent).toBe('StoryMe');
  });

  it('renders the primary CTA link', () => {
    render(<HomePage />);
    const cta = screen.getByRole('link', { name: /create your first book/i });
    expect(cta).toBeDefined();
  });

  it('renders a link to view existing books', () => {
    render(<HomePage />);
    const viewBooks = screen.getByRole('link', { name: /view my books/i });
    expect(viewBooks).toBeDefined();
  });

  it('points the primary CTA and secondary link at real in-app routes', () => {
    render(<HomePage />);
    const cta = screen.getByRole('link', { name: /create your first book/i }) as HTMLAnchorElement;
    const viewBooks = screen.getByRole('link', { name: /view my books/i }) as HTMLAnchorElement;
    expect(cta.getAttribute('href')).toBe('/dashboard/books/new');
    expect(viewBooks.getAttribute('href')).toBe('/dashboard');
  });
});
