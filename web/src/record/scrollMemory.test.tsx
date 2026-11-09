import { act, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { describe, expect, it } from "vitest";
import { RestoredScroll } from "./scrollMemory";

let go: ReturnType<typeof useNavigate>;
function Nav() {
  go = useNavigate();
  return null;
}

function app() {
  return render(
    <MemoryRouter initialEntries={["/list"]}>
      <Nav />
      <Routes>
        <Route
          path="/list"
          element={
            <RestoredScroll data-testid="page">
              <div data-scroll-restore="list" data-testid="list" />
            </RestoredScroll>
          }
        />
        <Route path="/record" element={<p>record</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

describe("the collection screen's scroll across a record page", () => {
  it("is put back when the way back lands on the entry it was left at", async () => {
    const view = app();
    const list = view.getByTestId("list");
    list.scrollTop = 1800;
    act(() => void list.dispatchEvent(new Event("scroll")));
    await act(frame);
    await act(frame);

    act(() => void go("/record"));
    expect(view.queryByTestId("list")).toBeNull();
    act(() => void go(-1));
    await waitFor(() => expect(view.getByTestId("list").scrollTop).toBe(1800));
  });

  it("is not put back on an entry the person has not been to (a new visit starts at the top)", async () => {
    const view = app();
    const list = view.getByTestId("list");
    list.scrollTop = 900;
    act(() => void list.dispatchEvent(new Event("scroll")));
    await act(frame);
    await act(frame);
    act(() => void go("/record"));
    // A forward navigation to the list is a new entry.
    act(() => void go("/list"));
    await act(frame);
    expect(view.getByTestId("list").scrollTop).toBe(0);
  });
});
