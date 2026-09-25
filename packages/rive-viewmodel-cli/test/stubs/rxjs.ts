export interface Observable<T> {
  subscribe(next: (value: T) => void): unknown;
}
