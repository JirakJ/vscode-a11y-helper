export function Card({ title, onOpen }: { title: string; onOpen: () => void }) {
  return (
    <section>
      <h4>{title}</h4>
      <img src="/thumb.png" alt="image of thumbnail" />
      <span onClick={onOpen}>Open</span>
      <a href="javascript:void(0)" onClick={onOpen}>Read more</a>
    </section>
  );
}
