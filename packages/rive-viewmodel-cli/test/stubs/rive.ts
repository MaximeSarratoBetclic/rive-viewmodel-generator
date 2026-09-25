import { Observable } from 'rxjs';

export interface UntypedRiveViewModel {
  setNumber(name: string, value: number, nestedViewModel?: string): void;
  setString(name: string, value: string, nestedViewModel?: string): void;
  setBoolean(name: string, value: boolean, nestedViewModel?: string): void;
  setEnum(name: string, value: string, nestedViewModel?: string): void;
  setColor(name: string, value: number, nestedViewModel?: string): void;
  setImage(
    name: string,
    url: string,
    nestedViewModel?: string,
  ): Observable<void>;
  fireTrigger(name: string, nestedViewModel?: string): void;
}

export interface RiveNestedViewModelInstanceParams {
  propertyName: string;
  viewModelName: string;
  instanceName: string;
}

export interface RiveGlobalViewModelInstanceParams {
  viewModelName: string;
  instanceName: string;
}

export interface RiveBindViewModelInstanceParams {
  viewModelName?: string;
  instanceName?: string;
  nestedInstances?: readonly RiveNestedViewModelInstanceParams[];
  globalInstances?: readonly RiveGlobalViewModelInstanceParams[];
}
